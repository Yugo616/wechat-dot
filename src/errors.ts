// The content itself cannot be sent; retrying the same bytes cannot repair it.
export class MessageContentError extends Error {
  override name = 'MessageContentError';
}

export function restoreError(message: string, name?: string): Error {
  const error = name === 'MessageContentError' ? new MessageContentError(message) : new Error(message);
  if (name) error.name = name;
  return error;
}
