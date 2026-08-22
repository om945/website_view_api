export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "OAUTH_FAILED"
  | "OAUTH_STATE_INVALID"
  | "AUTH_NOT_CONFIGURED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_DOMAIN"
  | "CSRF_FAILED";

export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode;
    message: string;
    status: number;
    requestId?: string;
  };
};

export const apiError = (
  code: ApiErrorCode,
  message: string,
  status = 400,
): ApiErrorResponse => ({
  error: { code, message, status },
});

export function userFacingMessage(code: ApiErrorCode): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "You're not signed in. Please sign in to continue.";
    case "SESSION_EXPIRED":
      return "Your session has expired. Please sign in again.";
    case "FORBIDDEN":
      return "You don't have permission to access this resource.";
    case "NOT_FOUND":
      return "The requested resource could not be found.";
    case "CONFLICT":
      return "A website with this information is already connected to your account.";
    case "RATE_LIMITED":
      return "Too many requests. Please wait a moment and try again.";
    case "PAYLOAD_TOO_LARGE":
      return "The request was too large. Please reduce the payload size.";
    case "OAUTH_FAILED":
      return "Google sign-in couldn't be completed. Please try again.";
    case "OAUTH_STATE_INVALID":
      return "We couldn't securely complete sign-in. Please start the sign-in process again.";
    case "AUTH_NOT_CONFIGURED":
      return "Authentication is temporarily unavailable. Please try again later.";
    case "SERVICE_UNAVAILABLE":
      return "The service is temporarily unavailable. Please try again in a moment.";
    case "INVALID_DOMAIN":
      return "Please enter a valid domain, such as example.com.";
    case "VALIDATION_ERROR":
      return "The request contained invalid data. Please check your input.";
    case "CSRF_FAILED":
      return "The request could not be verified. Please try again.";
    case "INTERNAL_ERROR":
      return "Something went wrong while processing your request.";
  }
}
