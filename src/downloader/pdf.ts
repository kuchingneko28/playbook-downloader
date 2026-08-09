import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { BaseDownloader, DownloaderOptions } from "./base";
import { decryptPage } from "../utils/crypto";
import { logger, withSpinner } from "../utils/logger";
import { GoogleBookMetadata, GoogleBookPageManifest, GoogleBookTocEntry } from "../types";
import { safeName, unescapeHtml } from "../utils/text";
import { delay, fetchWithRetry, concurrentMap } from "../utils/async";

export class PdfDownloader extends BaseDownloader {
  private cachedFiles: Set<string> = new Set();

  constructor(bookId: string, options: DownloaderOptions) {
    super(bookId, options);
  }

  /**
   * Downloads a single encrypted page and decrypts it.
   */
  async downloadAndDecryptPage(
    src: string,
    aesKey: Buffer,
    pid: string,
    order: number,
    totalPages: number
  ): Promise<string> {
    const url = new URL(src);
    const params = url.searchParams;

    // Force highest resolution and standard parameters
    params.set("w", "10000");
    params.set("h", "10000");
    params.set("zoom", "3");
    params.set("enc_all", "1");
    params.set("img", "1");
    url.search = params.toString();

    logger.debug(`Downloading page pid: ${pid}, order: ${order} from URL: ${url.toString()}`);

    // Check if file already exists in cache
    const existingFile = [...this.cachedFiles].find((file) => file.startsWith(pid));
    if (existingFile) {
      logger.debug(`Page ${pid} already exists in cache, skipping download`);
      return path.join(this.bookTempDir, existingFile);
    }

    // Try fetching with preferred formats, falling back if WebP is returned
    let lastError: Error | null = null;
    const tryFetch = async (accept: string): Promise<{ response: Response; extension: string } | null> => {
      const headers = { ...this.headers, accept };
      const response = await fetchWithRetry(url.toString(), { headers });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        return null;
      }
      const contentType = response.headers.get("content-type") || "image/jpeg";
      if (contentType.includes("webp")) return null;
      const extension = contentType.includes("png") ? "png" : "jpeg";
      return { response, extension };
    };

    const acceptPrefs = [
      "image/png,image/jpeg,image/*;q=0.8",
      "image/png,image/jpeg;q=0.9,*/*;q=0.1",
      "image/png",
    ];

    let result: { response: Response; extension: string } | null = null;
    for (const accept of acceptPrefs) {
      result = await tryFetch(accept);
      if (result || lastError) break;
    }

    if (!result) {
      const detail = lastError ? (lastError as Error).message : "unacceptable image format returned";
      throw new Error(`Failed to download page ${pid}: ${detail}`);
    }

    const { response, extension } = result;
    const filename = `${pid}.${extension}`;
    const filepath = path.join(this.bookTempDir, filename);

    const arrayBuffer = await response.arrayBuffer();
    try {
      const decrypted = decryptPage(Buffer.from(arrayBuffer), aesKey);
      await Bun.write(filepath, decrypted);
    } catch {
      throw new Error(`Decryption failed (BAD_DECRYPT). This usually indicates your cookies in cookies.txt are invalid or expired.`);
    }

    this.cachedFiles.add(filename);

    logger.debug(`Decrypted page ${pid} and saved to: ${filepath}`);

    return filepath;
  }

  /**
   * Merges all downloaded images into a single PDF with metadata.
   */
  async createPdf(imagePaths: string[], metadata: GoogleBookMetadata): Promise<string> {
    const pdfDoc = await PDFDocument.create();

    const title = metadata.title || "Untitled";
    const authorString = Array.isArray(metadata.authors)
      ? metadata.authors.join(", ")
      : metadata.authors || "Unknown Author";

    // Set PDF standard metadata
    pdfDoc.setTitle(title);
    pdfDoc.setAuthor(authorString);
    pdfDoc.setProducer(metadata.publisher || "Unknown Publisher");
    pdfDoc.setSubject("Downloaded from Google Play Books");
    pdfDoc.setKeywords(["Google Play", "eBook", title]);
    pdfDoc.setCreationDate(new Date());

    const total = imagePaths.length;
    logger.step(`Merging ${total} pages into PDF...`);

    for (let i = 0; i < total; i++) {
      const imagePath = imagePaths[i];
      try {
        const bytes = fs.readFileSync(imagePath);
        const isPng = imagePath.endsWith(".png");
        const image = isPng
          ? await pdfDoc.embedPng(bytes)
          : await pdfDoc.embedJpg(bytes);

        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });

        logger.progress(i + 1, total, `Merging page ${path.basename(imagePath)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`\nFailed to embed page ${i + 1} (${imagePath}): ${msg}`);
      }
    }
    logger.clearProgress();

    const pdfBytes = await pdfDoc.save();
    const safeTitle = safeName(title);
    const pdfFilename = `${safeTitle}.pdf`;
    const outputPath = path.join(this.bookOutputDir, pdfFilename);

    fs.writeFileSync(outputPath, pdfBytes);
    return outputPath;
  }

  /**
   * Reorders pages to adjust for Right-to-Left (RTL) reading layouts.
   */
  private adjustRtlPages(pages: GoogleBookPageManifest[]): GoogleBookPageManifest[] {
    if (pages.length <= 2) return pages;

    const front = pages[0];
    const back = pages[pages.length - 1];
    const middle = pages.slice(1, pages.length - 1);
    const reversedMiddle: GoogleBookPageManifest[] = [];

    for (let i = 0; i < middle.length; i += 2) {
      const chunk = middle.slice(i, i + 2);
      chunk.reverse();
      reversedMiddle.push(...chunk);
    }

    return [front, ...reversedMiddle, back];
  }

  /**
   * Generates and saves a human-readable table of contents text file.
   */
  public saveToc(toc: GoogleBookTocEntry[], title: string): void {
    const formattedToc = toc
      .map((entry) => {
        const indent = "  ".repeat(entry.depth || 0);
        const label = unescapeHtml(entry.label);
        return `${indent}${label}`.padEnd(60, ".") + ` p.${(entry.page_index || 0) + 1}`;
      })
      .join("\n");

    const tocPath = path.join(this.bookOutputDir, `${safeName(title)}_TOC.txt`);
    fs.writeFileSync(tocPath, formattedToc);
    logger.info(`Table of contents saved to: ${tocPath}`);
  }

  /**
   * Core download runner for PDF.
   */
  async run(): Promise<void> {
    const { html, manifest } = await withSpinner("Fetching book details...", async () => {
      const htmlText = await this.getBookHtml();
      const manifestData = await this.getManifest();
      return { html: htmlText, manifest: manifestData };
    });
    const aesKey = this.getKey(html);
    const metadata = manifest.metadata || {};
    const toc = this.getToc(html);

    if (!manifest.page || manifest.page.length === 0) {
      throw new Error("This book does not contain scanned pages (PDF format is unavailable). Try downloading as EPUB.");
    }

    if (metadata.preview && metadata.preview !== "full") {
      logger.warn(`The book metadata indicates preview mode ('${metadata.preview}'). Downloading available pages...`);
    }

    const missingPages = manifest.page.filter((page) => !page.src);
    if (missingPages.length > 0) {
      const pct = ((missingPages.length / manifest.page.length) * 100).toFixed(2);
      const listStr = logger.showDebug
        ? ` List of missing pages: [${missingPages.map((page) => page.pid).join(", ")}].`
        : "";
      logger.warn(`Could not find a download link for ${missingPages.length} pages (${pct}% missing, total: ${manifest.page.length}).${listStr} You might need to update your cookies.`);
    }

    // Populate existing cached files
    this.cachedFiles = new Set(fs.readdirSync(this.bookTempDir));

    const title = metadata.title || metadata.volume_title || "Untitled";
    const safeTitle = safeName(title);
    const pdfFilename = `${safeTitle}.pdf`;

    this.prepareOutputDir(safeTitle);
    const outputPath = path.join(this.bookOutputDir, pdfFilename);

    if (fs.existsSync(outputPath)) {
      logger.success(`Book already exists in downloads: ${outputPath}`);
      return;
    }

    const authors = metadata.authors || metadata.author || metadata.creator || "Unknown Author";
    const pub_date = metadata.pub_date || metadata.pubDate || metadata.date || metadata.publication_date || new Date().getFullYear().toString();
    const publisher = metadata.publisher || "Unknown Publisher";
    const num_pages = metadata.num_pages || manifest.page?.length || 0;
    let pages = manifest.page;

    logger.step(`Processing book: ${title}`);
    logger.info(`Authors     : ${Array.isArray(authors) ? authors.join(", ") : authors}`);
    logger.info(`Published   : ${pub_date}`);
    logger.info(`Total Pages : ${num_pages}`);
    logger.info(`Publisher   : ${publisher}`);

    let validPages = pages.filter((page) => page.src);
    if (validPages.length === 0) {
      throw new Error("No accessible pages with download links found. Please check your account ownership and cookies.");
    }

    if (manifest.is_right_to_left) {
      logger.warn("Book is marked as right-to-left (RTL). Adjusting page pairs order.");
      validPages = this.adjustRtlPages(validPages);
    }

    logger.step(`Downloading ${validPages.length} pages...`);
    const concurrency = this.options.concurrency || 1;

    let completedCount = 0;
    const imagePaths: string[] = await concurrentMap(
      validPages,
      concurrency,
      async (page) => {
        const { pid, src, order } = page;
        const imagePath = await this.downloadAndDecryptPage(
          src!,
          aesKey,
          pid,
          order,
          validPages.length,
        );
        completedCount++;
        logger.progress(completedCount, validPages.length, `Saved page ${pid}`);

        if (concurrency <= 1 && this.options.pace > 0 && completedCount < validPages.length) {
          await delay(this.options.pace);
        }

        return imagePath;
      },
    );
    logger.clearProgress();

    const pdfPath = await this.createPdf(imagePaths, metadata);
    logger.success(`PDF saved successfully: ${pdfPath}`);

    // Save Table of Contents if available
    if (toc && toc.length > 0) {
      this.saveToc(toc, title);
    }

    this.saveMetadata(metadata, title);
    this.cleanup();
  }
}
