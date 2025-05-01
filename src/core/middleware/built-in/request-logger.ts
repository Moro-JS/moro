// Simple request logging middleware
export const requestLogger = async (context: any): Promise<void> => {
  const startTime = Date.now();

  console.log(
    `[${new Date().toISOString()}] ${context.request?.method} ${context.request?.path}`,
  );

  // Log completion after response
  context.onComplete = () => {
    const duration = Date.now() - startTime;
    console.log(`Request completed in ${duration}ms`);
  };
};
