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
  new ApiError(503, "unavailable", "Approval service unavailable.");
export const missing = () =>
  new ApiError(404, "not_found", "Document not found.");
export const forbidden = () =>
  new ApiError(403, "forbidden", "Permission denied.");
export const conflict = () =>
  new ApiError(409, "conflict", "Document changed or is already completed.");
