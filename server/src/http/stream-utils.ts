export function onceDrainOrError(output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener("drain", onDrain);
      output.removeListener("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    output.once("drain", onDrain);
    output.once("error", onError);
  });
}

export function endStream(output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener("finish", onFinish);
      output.removeListener("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    output.once("finish", onFinish);
    output.once("error", onError);
    output.end();
  });
}

export function trackWriteStreamError(output: NodeJS.WritableStream): () => Error | undefined {
  let tracked: Error | undefined;
  output.on("error", (error) => {
    tracked = error instanceof Error ? error : new Error(String(error));
  });
  return () => tracked;
}

export function throwTrackedStreamError(error: () => Error | undefined): void {
  const tracked = error();
  if (tracked) throw tracked;
}
