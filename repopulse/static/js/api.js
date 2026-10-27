// JSON API client. Adds the CSRF token to every request that changes data.

export const session = { user: null, csrf: null };

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && session.csrf) headers["X-CSRF-Token"] = session.csrf;
  let res;
  try {
    res = await fetch(path, {
      method, headers, signal, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("The server could not be reached. Check that RepoPulse is running.", 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && session.user) {
      session.user = null; session.csrf = null;
      window.dispatchEvent(new CustomEvent("repopulse:logged-out"));
    }
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}
