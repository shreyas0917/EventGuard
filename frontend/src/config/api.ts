/**
 * Centralized API Configuration & Safe Request Helpers
 */

export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

/**
 * Safely parse JSON responses without crashing on HTML/text error bodies
 */
export async function parseResponseJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      error: text || `HTTP ${res.status} ${res.statusText}`,
      status: res.status,
    };
  }
}
