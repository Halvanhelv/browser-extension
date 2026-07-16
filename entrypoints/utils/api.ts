import { createApiClient } from "@solidtime/api";
import { accessToken, endpoint, refreshAccessToken } from "./oauth";

export const apiClient = () => {
  const client = createApiClient(endpoint.value + "/api", {
    validate: "none",
    axiosConfig: {
      headers: {
        Authorization: `Bearer ${accessToken.value}`,
      },
    },
  });

  // Add response interceptor to handle 401 errors and refresh token
  client.axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      // If 401 and we haven't already tried to refresh
      if (error.response?.status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;

        try {
          await refreshAccessToken();

          // Retry the original request with new token
          originalRequest.headers.Authorization = `Bearer ${accessToken.value}`;
          return client.axios(originalRequest);
        } catch (refreshError) {
          // Refresh failed, user needs to log in again
          return Promise.reject(refreshError);
        }
      }

      return Promise.reject(error);
    },
  );

  return client;
};

/**
 * Turns an axios-style error into a short, actionable message (HTTP status +
 * server message) for the injected page buttons, instead of a blanket
 * "make sure you are logged in" that hid real failures like validation errors.
 */
export function describeToggleError(error: unknown): string {
  const err = error as {
    response?: {
      status?: number;
      data?: { message?: string; error?: string };
    };
    message?: string;
  };
  const status = err?.response?.status;
  const serverMessage =
    err?.response?.data?.message || err?.response?.data?.error;
  if (status) {
    return `HTTP ${status}${serverMessage ? `: ${serverMessage}` : ""}`;
  }
  return err?.message || "Unknown error";
}
