/** Edge-safe instrumentation entry. Node-only startup lives in instrumentation.node.ts */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { registerNodeInstrumentation } = await import('./instrumentation.node');
  await registerNodeInstrumentation();
}
