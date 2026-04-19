export const waitImmediateTaskTurn = () => new Promise<void>((resolve) => {
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
    return;
  }

  setTimeout(resolve, 0);
});

export const yieldToMainThread = async (frames: number = 1) => {
  const waitSingleFrame = () => {
    const canWaitForVisibleFrame =
      typeof requestAnimationFrame === 'function'
      && typeof document !== 'undefined'
      && !document.hidden;

    if (canWaitForVisibleFrame) {
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    return waitImmediateTaskTurn();
  };

  for (let index = 0; index < Math.max(1, frames); index += 1) {
    await waitSingleFrame();
  }
};
