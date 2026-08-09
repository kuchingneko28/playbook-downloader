import fs from "fs";
import path from "path";
import { BaseDownloader, DownloaderOptions } from "./base";
import { decryptSegment, decryptPage } from "../utils/crypto";
import { buildEpub, Chapter, Cover, EpubImage } from "../utils/epub-builder";
import { logger, withSpinner } from "../utils/logger";
import { GoogleBookSegment } from "../types";
import { safeName, escapeRegex } from "../utils/text";
import { delay, fetchWithRetry, concurrentMap } from "../utils/async";

export class EpubDownloader extends BaseDownloader {
  private epubImages: EpubImage[] = [];

  constructor(bookId: string, options: DownloaderOptions) {
    super(bookId, options);
  }

  /**
   * Processes the XHTML segment to find external resources (like images),
   * downloads them, and stores them in memory.
   */
  async processAndDownloadImages(html: string, segmentLabel: string): Promise<string> {
    const urlRegex = /(?:src|href|xlink:href)=["'](https?:\/\/[^"']+)["']/gi;
    let match;
    const urls = new Set<string>();

    while ((match = urlRegex.exec(html)) !== null) {
      urls.add(match[1]);
    }

    let resultHtml = html;
    let imageCounter = 1;
    const urlToFilename = new Map<string, string>();

    // Sort URLs by length descending to avoid substring collisions during replacement
    const sortedUrls = [...urls].sort((a, b) => b.length - a.length);

    for (const url of sortedUrls) {
      try {
        logger.debug(`Downloading inline image: ${url}`);

        // Fix XML-escaped ampersands inside URL query parameters (e.g. &amp; -> &)
        const cleanUrl = url.replace(/&amp;/g, "&");
        const response = await fetchWithRetry(cleanUrl, { headers: this.headers });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get("content-type") || "image/jpeg";
        
        // Determine file extension
        let ext = "jpg";
        if (contentType.includes("png")) ext = "png";
        else if (contentType.includes("webp")) ext = "webp";
        else if (contentType.includes("gif")) ext = "gif";
        else if (contentType.includes("svg")) ext = "svg";

        const filename = `images/${segmentLabel}_${imageCounter}.${ext}`;
        imageCounter++;

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Store image data in memory
        this.epubImages.push({
          filename,
          data: buffer,
          mimeType: contentType,
        });

        urlToFilename.set(url, filename);

        logger.debug(`Saved image inside EPUB memory under: ${filename}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logWarn(`Failed to download image ${url}: ${msg}`);
      }
    }

    // Single-pass replacement to avoid substring corruption
    if (urlToFilename.size > 0) {
      const urlPatterns = [...urlToFilename.keys()]
        .map((url) => escapeRegex(url))
        .join("|");
      resultHtml = resultHtml.replace(
        new RegExp(`(["'])(${urlPatterns})\\1`, "g"),
        (_, quote, url) => quote + urlToFilename.get(url) + quote,
      );
    }

    return resultHtml;
  }

  /**
   * Ensures the XHTML has a link to its stylesheet.
   */
  linkStylesheet(xhtml: string, label: string): string {
    const linkTag = `<link rel="stylesheet" type="text/css" href="${label}.css" />`;
    if (xhtml.includes("</head>")) {
      return xhtml.replace("</head>", `${linkTag}\n</head>`);
    } else if (xhtml.includes("<head>")) {
      return xhtml.replace("<head>", `<head>\n${linkTag}`);
    } else {
      const htmlMatch = xhtml.match(/<html[^>]*>/i);
      if (htmlMatch) {
        return xhtml.replace(htmlMatch[0], `${htmlMatch[0]}\n<head>${linkTag}</head>`);
      }
      return `<head>${linkTag}</head>\n${xhtml}`;
    }
  }

  /**
   * Downloads the book cover image from Google's content server.
   */
  async downloadCover(): Promise<Cover | undefined> {
    try {
      const coverUrl = `https://books.google.com/books/content?id=${this.bookId}&printsec=frontcover&img=1&zoom=3`;
      logger.info("Downloading book cover image...");
      const response = await fetchWithRetry(coverUrl, { headers: this.headers });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const mimeType = response.headers.get("content-type") || "image/jpeg";
      const arrayBuffer = await response.arrayBuffer();
      return {
        data: Buffer.from(arrayBuffer),
        mimeType,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logWarn(`Could not download book cover: ${msg}. EPUB will be built without a cover page.`);
      return undefined;
    }
  }

  /**
   * Downloads page background images for fixed-layout segments and embeds them.
   */
  private async embedFixedLayoutPageImages(
    segmentHtml: string,
    segmentObj: GoogleBookSegment,
    aesKey: Buffer,
    label: string
  ): Promise<string> {
    let resultHtml = segmentHtml;
    if (!segmentObj.page || segmentObj.page.length === 0) {
      return resultHtml;
    }

    for (const page of segmentObj.page) {
      if (page.src) {
        try {
          logger.debug(`Downloading segment page image: ${page.pid}`);
          const pageUrl = new URL(page.src);
          pageUrl.searchParams.set("w", "10000");
          pageUrl.searchParams.set("h", "10000");
          pageUrl.searchParams.set("zoom", "3");
          pageUrl.searchParams.set("enc_all", "1");
          pageUrl.searchParams.set("img", "1");

          const response = await fetchWithRetry(pageUrl.toString(), { headers: this.headers });
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          const contentType = response.headers.get("content-type") || "image/jpeg";
          const ext = contentType.includes("png") ? "png" : "jpeg";
          const filename = `images/${page.pid}.${ext}`;

          const arrayBuffer = await response.arrayBuffer();
          const decryptedImage = decryptPage(Buffer.from(arrayBuffer), aesKey);

          this.epubImages.push({
            filename,
            data: decryptedImage,
            mimeType: contentType,
          });

          // Embed the image inside the segment container div
          const imgTag = `<img src="${filename}" style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: -1;" />`;
          const matchSegment = resultHtml.match(/<div[^>]*class="[^"]*gb-segment[^"]*"[^>]*>/i);
          if (matchSegment) {
            const insertIndex = resultHtml.indexOf(matchSegment[0]) + matchSegment[0].length;
            resultHtml = resultHtml.slice(0, insertIndex) + "\n" + imgTag + resultHtml.slice(insertIndex);
          } else {
            resultHtml = imgTag + "\n" + resultHtml;
          }
        } catch (imgErr) {
          const msg = imgErr instanceof Error ? imgErr.message : String(imgErr);
          logger.warn(`Failed to download page image ${page.pid} for segment ${label}: ${msg}`);
        }
      }
    }
    return resultHtml;
  }

  /**
   * Downloads and decrypts a single segment, processing fixed layout pages and inline images.
   */
  private async downloadAndProcessSegment(
    segment: { label: string; title?: string; link?: string },
    aesKey: Buffer,
    i: number,
    total: number
  ): Promise<Chapter | null> {
    const { label, title: chapterTitle, link } = segment;

    if (!link) {
      if (!logger.showDebug) process.stdout.write("\n");
      logger.info(`[${i + 1}/${total}] Skipped segment ${label} (missing link)`);
      return null;
    }

    // Format URL correctly
    const segmentUrl = link.startsWith("http")
      ? link
      : `https://play.google.com${link}`;

    const urlObj = new URL(segmentUrl);
    urlObj.searchParams.set("enc_all", "1");
    urlObj.searchParams.set("hl", "en");

    try {
      logger.debug(`Downloading segment ${label} from: ${urlObj.toString()}`);
      const response = await fetchWithRetry(urlObj.toString(), {
        headers: this.headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const text = await response.text();
      const encBuffer = Buffer.from(text, "base64");
      
      let decryptedText = "";
      try {
        decryptedText = decryptSegment(encBuffer, aesKey);
      } catch {
        throw new Error(`Decryption failed (BAD_DECRYPT). This usually indicates your cookies in cookies.txt are invalid or expired.`);
      }

      let segmentObj: GoogleBookSegment;
      try {
        segmentObj = JSON.parse(decryptedText) as GoogleBookSegment;
      } catch {
        throw new Error(`Failed to parse decrypted segment JSON. This usually indicates your cookies in cookies.txt are invalid or expired (Key mismatch).`);
      }
      
      let segmentHtml = segmentObj.content || "";
      const segmentCss = segmentObj.style || "";

      // If this is a fixed-layout page containing a page image definition, download and embed it.
      segmentHtml = await this.embedFixedLayoutPageImages(segmentHtml, segmentObj, aesKey, label);

      logger.debug(`Decrypted segment ${label} (${decryptedText.length} chars). Downloading inline images...`);

      // Download inline images, save them inside the zip, and point xhtml links to local files
      segmentHtml = await this.processAndDownloadImages(segmentHtml, label);

      // Inject the link to stylesheet in the xhtml head
      const finalHtml = this.linkStylesheet(segmentHtml, label);

      const displayTitle = chapterTitle && chapterTitle !== "Untitled" ? ` (${chapterTitle})` : "";
      logger.progress(i + 1, total, `Saved segment ${label}${displayTitle}`);

      return {
        label,
        title: chapterTitle || label,
        xhtml: finalHtml,
        css: segmentCss,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`\nFailed to download/decrypt segment ${label}: ${msg}`);
      return null;
    }
  }

  /**
   * Core download runner for EPUB.
   */
  async run(): Promise<void> {
    const { html, manifest } = await withSpinner("Fetching book details...", async () => {
      const htmlText = await this.getBookHtml();
      const manifestData = await this.getManifest();
      return { html: htmlText, manifest: manifestData };
    });
    const aesKey = this.getKey(html);
    const metadata = manifest.metadata || {};

    if (!manifest.segment || manifest.segment.length === 0) {
      throw new Error("This book does not contain reflowable text segments (EPUB format is unavailable). Try downloading as PDF.");
    }

    if (metadata.preview && metadata.preview !== "full") {
      logger.warn(`The book metadata indicates preview mode ('${metadata.preview}'). Downloading available text segments...`);
    }

    const missingSegments = manifest.segment.filter((segment) => !segment.link);
    if (missingSegments.length > 0) {
      const pct = ((missingSegments.length / manifest.segment.length) * 100).toFixed(2);
      const listStr = logger.showDebug
        ? ` List of missing segments: [${missingSegments.map(segment => segment.label).join(", ")}].`
        : "";
      logger.warn(`Could not find a download link for ${missingSegments.length} text segments (${pct}% missing, total: ${manifest.segment.length}).${listStr} You might need to update your cookies.`);
    }

    const title = metadata.title || metadata.volume_title || "Untitled";
    const safeTitle = safeName(title);
    const epubFilename = `${safeTitle}.epub`;

    this.prepareOutputDir(safeTitle);
    const outputPath = path.join(this.bookOutputDir, epubFilename);

    if (fs.existsSync(outputPath)) {
      logger.success(`Book already exists in downloads: ${outputPath}`);
      return;
    }

    const authors = metadata.authors || metadata.author || metadata.creator || "Unknown Author";
    const pub_date = metadata.pub_date || metadata.pubDate || metadata.date || metadata.publication_date || new Date().getFullYear().toString();
    const publisher = metadata.publisher || "Unknown Publisher";
    const segments = manifest.segment;
    const language = manifest.language || "en";

    logger.step(`Processing book: ${title}`);
    logger.info(`Authors     : ${Array.isArray(authors) ? authors.join(", ") : authors}`);
    logger.info(`Published   : ${pub_date}`);
    logger.info(`Segments    : ${segments.length}`);
    logger.info(`Publisher   : ${publisher}`);
    logger.info(`Language    : ${language}`);

    // Reset images cache
    this.epubImages = [];

    // Try downloading the cover
    const cover = await this.downloadCover();

    const validSegments = segments.filter((segment) => segment.link);
    if (validSegments.length === 0) {
      throw new Error("No accessible text segments with download links found. Please check your account ownership and cookies.");
    }

    logger.step(`Downloading and decrypting ${validSegments.length} text segments...`);
    const concurrency = this.options.concurrency || 1;

    const chapters: Chapter[] = [];
    let completedCount = 0;

    const results = await concurrentMap(
      validSegments,
      concurrency,
      async (segment, idx) => {
        const chapter = await this.downloadAndProcessSegment(segment, aesKey, idx, validSegments.length);
        completedCount++;
        if (chapter) {
          const displayTitle = chapter.title && chapter.title !== "Untitled" ? ` (${chapter.title})` : "";
          logger.progress(completedCount, validSegments.length, `Saved segment ${chapter.label}${displayTitle}`);
        }

        if (concurrency <= 1 && this.options.pace > 0 && completedCount < validSegments.length) {
          await delay(this.options.pace);
        }

        return chapter;
      },
    );

    for (const chapter of results) {
      if (chapter) chapters.push(chapter);
    }
    logger.clearProgress();

    logger.step("Assembling EPUB book archive...");

    const epubMetadata = {
      title,
      authors: Array.isArray(authors)
        ? authors
        : typeof authors === "string"
        ? authors.split(",").map((author: string) => author.trim())
        : ["Unknown Author"],
      publisher: publisher || "Unknown Publisher",
      pubDate: pub_date || new Date().getFullYear().toString(),
      language,
      volumeId: this.bookId,
    };

    await buildEpub(outputPath, epubMetadata, chapters, cover, this.epubImages);

    logger.success(`EPUB saved successfully: ${outputPath}`);

    this.saveMetadata(metadata, title);
    this.cleanup();
  }
}
