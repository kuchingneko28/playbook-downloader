import { cac } from 'cac';
import fs from 'fs';
import path from 'path';
import { EpubDownloader } from './downloader/epub';
import { PdfDownloader } from './downloader/pdf';
import { GoogleBookManifest } from './types';
import { getCookieHeader } from './utils/cookie';
import { fetchWithRetry } from './utils/async';
import { logger, intro, outro, withSpinner } from './utils/logger';

interface CliOptions {
  format: 'pdf' | 'epub' | 'auto';
  cookies: string;
  output: string;
  temp: string;
  pace: string;
  concurrency: string;
  verbose: boolean;
  metadataOnly: boolean;
}

/**
 * Automatically detects the format by inspecting the book manifest content.
 */
async function detectFormat(
  bookId: string,
  cookiesPath: string
): Promise<{ format: 'pdf' | 'epub'; manifest: GoogleBookManifest }> {
  const cookieHeader = getCookieHeader(cookiesPath);
  const headers = {
    cookie: cookieHeader,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  };
  const url = `https://play.google.com/books/volumes/${bookId}/manifest?hl=en&source=ge-web-app`;

  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch book manifest: ${response.statusText} (${response.status})`);
  }

  const manifest = (await response.json()) as GoogleBookManifest;
  if (manifest.segment && manifest.segment.length > 0) {
    return { format: 'epub', manifest };
  }
  if (manifest.page && manifest.page.length > 0) {
    return { format: 'pdf', manifest };
  }
  throw new Error('No readable segments or pages found in book manifest.');
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled Rejection: ${msg}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const cli = cac('playbook');

  cli
    .command('[book-id]', 'Download Google Play Book by ID')
    .option('-f, --format <format>', 'Output format (pdf, epub, or auto)', { default: 'pdf' })
    .option('-c, --cookies <path>', 'Path to your cookies.txt file', { default: './cookies.txt' })
    .option('-o, --output <dir>', 'Directory to save downloaded books', { default: './downloads' })
    .option('-t, --temp <dir>', 'Directory for caching temporary files', { default: './temp' })
    .option('-p, --pace <ms>', 'Pacing delay in milliseconds between requests', { default: '300' })
    .option('-n, --concurrency <n>', 'Number of concurrent downloads (1 = sequential)', { default: '1' })
    .option('-v, --verbose', 'Enable verbose output logging', { default: false })
    .option('-m, --metadata-only', 'Save metadata and TOC JSON only without downloading book content', { default: false })
    .action(async (bookId: string | undefined, options: CliOptions) => {
      // If book-id is omitted, show the help menu
      if (!bookId) {
        cli.outputHelp();
        process.exit(0);
      }

      logger.showDebug = options.verbose;

      intro('Google Play Book Downloader');
      logger.info(`Book ID: ${bookId}`);

      // Resolve options paths
      const cookiesPath = path.resolve(options.cookies);
      const outputDir = path.resolve(options.output);
      const tempDir = path.resolve(options.temp);
      const paceMs = parseInt(options.pace, 10);
      const concurrency = parseInt(options.concurrency, 10);

      // Validate inputs
      if (!fs.existsSync(cookiesPath)) {
        logger.error(
          `Cookies file not found at: ${cookiesPath}\nPlease export cookies.txt from Play Books in your browser and place it here.`
        );
        process.exit(1);
      }

      const cookieStat = fs.statSync(cookiesPath);
      if (cookieStat.mode & 0o077) {
        const mode = cookieStat.mode & 0o777;
        logger.warn(
          `Cookies file is readable by others (permissions: ${mode.toString(8)}). Consider restricting it with: chmod 600 ${cookiesPath}`
        );
      }

      if (isNaN(paceMs) || paceMs < 0) {
        logger.error('Pacing delay must be a positive number.');
        process.exit(1);
      }

      if (isNaN(concurrency) || concurrency < 1) {
        logger.error('Concurrency must be a positive number.');
        process.exit(1);
      }

      // Register signal handlers for graceful temp cleanup
      const bookTempPath = path.join(tempDir, bookId);
      const cleanupOnSignal = () => {
        if (fs.existsSync(bookTempPath)) {
          fs.rmSync(bookTempPath, { recursive: true, force: true });
        }
        process.exit(0);
      };
      process.on('SIGINT', cleanupOnSignal);
      process.on('SIGTERM', cleanupOnSignal);

      let chosenFormat: 'pdf' | 'epub' = 'pdf';
      let preFetchedManifest: GoogleBookManifest | undefined;

      try {
        if (options.format === 'auto') {
          const detected = await withSpinner('Auto-detecting optimal format...', () =>
            detectFormat(bookId, cookiesPath)
          );
          chosenFormat = detected.format;
          preFetchedManifest = detected.manifest;
        } else if (options.format === 'pdf' || options.format === 'epub') {
          chosenFormat = options.format;
        } else {
          logger.error(`Invalid format '${options.format}'. Supported formats: pdf, epub, auto.`);
          process.exit(1);
        }

        const downloaderOptions = {
          cookiesPath,
          outputDir,
          tempDir,
          pace: paceMs,
          concurrency,
          verbose: options.verbose,
          interactive: false,
          manifest: preFetchedManifest,
        };

        if (options.metadataOnly) {
          logger.info('Extracting metadata and Table of Contents only...');
          const downloader = chosenFormat === 'pdf' ? new PdfDownloader(bookId, downloaderOptions) : new EpubDownloader(bookId, downloaderOptions);
          const html = await downloader.getBookHtml();
          const manifest = await downloader.getManifest();
          const metadata = manifest.metadata || {};
          const toc = downloader.getToc(html);
          const title = metadata.title || metadata.volume_title || 'Untitled';
          
          downloader.prepareOutputDir(title);
          downloader.saveMetadata(metadata, title);
          if (toc.length > 0 && downloader instanceof PdfDownloader) {
            downloader.saveToc(toc, title);
          }
          outro('Metadata extraction complete!');
          return;
        }

        if (chosenFormat === 'pdf') {
          const downloader = new PdfDownloader(bookId, downloaderOptions);
          await downloader.run();
        } else {
          const downloader = new EpubDownloader(bookId, downloaderOptions);
          await downloader.run();
        }
        outro('Download completed successfully!');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Execution Failed: ${msg}`);
        process.exit(1);
      }
    });

  cli.help();
  cli.version('2.0.0');
  cli.parse();
}

main();
