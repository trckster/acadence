export async function withSpinner<T>(message: string, action: () => Promise<T>): Promise<T> {
  const output = process.stderr;
  if (!output.isTTY || process.env.TERM === 'dumb') return action();

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  const render = () => output.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${message}`);
  const delay = setTimeout(() => {
    render();
    interval = setInterval(render, 80);
    interval.unref();
  }, 300);
  delay.unref();

  try {
    return await action();
  } finally {
    clearTimeout(delay);
    if (interval) {
      clearInterval(interval);
      output.write('\r\x1b[2K');
    }
  }
}
