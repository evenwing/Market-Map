const MAX_CONCURRENCY = Number(process.env.GEMINI_MAX_CONCURRENCY || 3);
const QUEUE_TIMEOUT_MS = Number(process.env.GEMINI_QUEUE_TIMEOUT_MS || 2000);

let activeCount = 0;
const waitQueue = [];

export async function withGeminiQueue(task, options = {}) {
  const timeoutMs = Number(options.timeoutMs || QUEUE_TIMEOUT_MS);
  const token = await acquireSlot(timeoutMs, options.onQueue);
  if (!token) {
    return { status: "timeout" };
  }

  try {
    const value = await task();
    return { status: "ok", value };
  } finally {
    token.release();
  }
}

function acquireSlot(timeoutMs, onQueue) {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount += 1;
    return Promise.resolve(createToken());
  }

  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: null
    };
    waitQueue.push(entry);
    if (typeof onQueue === "function") {
      onQueue(waitQueue.length);
    }
    entry.timer = setTimeout(() => {
      const index = waitQueue.indexOf(entry);
      if (index >= 0) {
        waitQueue.splice(index, 1);
      }
      resolve(null);
    }, timeoutMs);
  });
}

function releaseSlot() {
  activeCount = Math.max(0, activeCount - 1);
  if (!waitQueue.length) return;
  const next = waitQueue.shift();
  if (next?.timer) clearTimeout(next.timer);
  activeCount += 1;
  next.resolve(createToken());
}

function createToken() {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseSlot();
    }
  };
}
