export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const unavailable = () =>
  new ApiError(503, "unavailable", "Mail service unavailable.");
export const missing = () =>
  new ApiError(404, "not_found", "Message not found.");
export const forbidden = () =>
  new ApiError(403, "forbidden", "Permission denied.");
