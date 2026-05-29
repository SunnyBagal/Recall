import axios from "axios";
import { BACKEND_URL } from "../config";

export const api = axios.create({
  baseURL: BACKEND_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = token;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      if (
        !window.location.pathname.includes("/signin") &&
        !window.location.pathname.includes("/signup")
      ) {
        window.location.href = "/signin";
      }
    }
    return Promise.reject(error);
  }
);