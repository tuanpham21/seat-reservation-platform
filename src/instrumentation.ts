export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { bootServerRuntime } = await import("./server/runtime");
  await bootServerRuntime();
}
