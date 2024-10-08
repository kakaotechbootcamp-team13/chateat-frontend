import axios from 'axios';
import {logout, refreshAccessToken} from './authService.js';

const API_URL = "https://api-chateat.store";

const apiClient = axios.create({
    baseURL: API_URL,
    withCredentials: true,
});

const setAuthorizationHeader = (config, token) => {
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
};

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
    failedQueue.forEach(prom => {
        if (error) {
            prom.reject(error);
        } else {
            prom.resolve(token);
        }
    });

    failedQueue = [];
};

apiClient.interceptors.request.use((config) => {
    const excludedPaths = [
        '/members/join',
        '/auth/login',
        '/members/nickname-check',
        '/members/email-check',
    ];

    const isExcluded = excludedPaths.some(path => config.url.includes(path));

    if (!isExcluded) {
        const accessToken = localStorage.getItem('accessToken');
        setAuthorizationHeader(config, accessToken);
    }

    return config;
}, (error) => {
    return Promise.reject(error);
});

apiClient.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        let rawData = error.response?.data;

        if (typeof rawData === 'string') {
            try {
                rawData = rawData.split('}{').map((item, index, array) => {
                    if (index === 0) return item + '}';
                    if (index === array.length - 1) return '{' + item;
                    return '{' + item + '}';
                });
            } catch (e) {
                console.error("Failed to split combined JSON:", rawData);
                return Promise.reject(error);
            }
        } else {
            rawData = [rawData];
        }

        for (const data of rawData) {
            let responseData;
            try {
                responseData = typeof data === 'string' ? JSON.parse(data) : data;
            } catch (e) {
                console.error("Failed to parse JSON:", data);
                return Promise.reject(error);
            }

            const {status, message} = responseData;

            const isTokenExpiredError =
                (status === 400 && message === "토큰이 만료되었습니다.") ||
                (status === 401 && message === "Unauthorized");

            if (isTokenExpiredError && !originalRequest._retry) {
                if (isRefreshing) {
                    try {
                        const token = await new Promise((resolve, reject) => {
                            failedQueue.push({resolve, reject});
                        });
                        setAuthorizationHeader(originalRequest, token);
                        return apiClient(originalRequest);
                    } catch (err) {
                        return Promise.reject(err);
                    }
                }

                originalRequest._retry = true;
                isRefreshing = true;

                try {
                    const success = await refreshAccessToken();
                    if (success) {
                        const newAccessToken = localStorage.getItem('accessToken');
                        setAuthorizationHeader(originalRequest, newAccessToken);
                        processQueue(null, newAccessToken);
                        return apiClient(originalRequest);
                    } else {
                        processQueue(new Error("Failed to refresh token"), null);
                        await logout();
                    }
                } catch (err) {
                    processQueue(err, null);
                    return Promise.reject(err);
                } finally {
                    isRefreshing = false;
                }
            }
        }

        return Promise.reject(error);
    }
);

export default apiClient;
