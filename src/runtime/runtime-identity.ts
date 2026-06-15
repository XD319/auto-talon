export function resolveDefaultUserId(): string {
  return process.env.USERNAME ?? process.env.USER ?? "local-user";
}

export function resolveDefaultReviewerId(): string {
  return process.env.USERNAME ?? process.env.USER ?? "local-user";
}
