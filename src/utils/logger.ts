import * as clack from "@clack/prompts";

export const { intro, outro } = clack;

export async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  const spinner = clack.spinner();
  spinner.start(label);
  try {
    const result = await task();
    spinner.stop(label);
    return result;
  } catch (error) {
    spinner.stop(`${label} failed`);
    throw error;
  }
}

export const logger = {
  showDebug: false,

  info: (messageText: string): void => { clack.log.info(messageText); },
  success: (messageText: string): void => { clack.log.success(messageText); },
  warn: (messageText: string): void => { clack.log.warn(messageText); },
  error: (messageText: string): void => { clack.log.error(messageText); },
  step: (messageText: string): void => { clack.log.step(messageText); },
  debug: (messageText: string): void => {
    if (logger.showDebug) {
      clack.log.message(`[DEBUG] ${messageText}`);
    }
  },
  progress: (current: number, total: number, prefix: string): void => {
    if (logger.showDebug) {
      logger.info(`[${current}/${total}] ${prefix}`);
    } else {
      const percentage = Math.round((current / total) * 100);
      process.stdout.write(`\r\x1b[K  ${prefix}: ${current}/${total} (${percentage}%)`);
    }
  },
  clearProgress: (): void => {
    if (!logger.showDebug) {
      process.stdout.write("\n");
    }
  },
};
