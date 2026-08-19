export const apiError = (code: string, message: string, status = 400) => ({ error: { code, message, status } });
