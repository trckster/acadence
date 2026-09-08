import { emitKeypressEvents, type Key } from 'node:readline';

export async function select<T>(message: string, choices: { label: string; value: T }[]): Promise<T | undefined> {
  if (!choices.length) return;
  const input = process.stdin;
  const output = process.stdout;
  const raw = input.isRaw;
  let selected = 0;
  console.log(`${message} (↑/↓ to move, Enter to choose, Esc to cancel)`);
  const render = () => {
    output.write(choices.map((choice, index) => `${index === selected ? '❯' : ' '} ${choice.label}`).join('\n') + '\n');
  };
  render();
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const cleanup = () => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
      };
      const finish = (value?: T) => { cleanup(); resolve(value); };
      const onEnd = () => finish();
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onKey = (_text: string, key: Key) => {
        if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) return finish();
        if (key.name === 'return' || key.name === 'enter') return finish(choices[selected]!.value);
        if (key.name !== 'up' && key.name !== 'down') return;
        selected = (selected + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
        if (output.isTTY) output.write(`\x1b[${choices.length}A\x1b[0J`);
        render();
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.once('error', onError);
      input.resume();
      if (input.readableEnded) finish();
    });
  } finally {
    if (input.isTTY) input.setRawMode(raw);
    input.pause();
  }
}
