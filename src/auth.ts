import { Env, OAuth2Credentials } from "./types";
import { hashString } from "./utils/hashing";
import {
	CODE_ASSIST_ENDPOINT,
	CODE_ASSIST_API_VERSION,
	KV_CREDS_INDEX,
	OAUTH_CLIENT_ID,
	OAUTH_CLIENT_SECRET,
	OAUTH_REFRESH_URL,
	TOKEN_BUFFER_TIME,
	KV_TOKEN_KEY
} from "./config";

// Auth-related interfaces
interface TokenRefreshResponse {
	access_token: string;
	expires_in: number;
}

interface CachedTokenData {
	access_token: string;
	expiry_date: number;
	cached_at: number;
}

interface TokenCacheInfo {
	cached: boolean;
	cached_at?: string;
	expires_at?: string;
	time_until_expiry_seconds?: number;
	is_expired?: boolean;
	message?: string;
	error?: string;
}

// KV-based exhaustion tracking constants
const KV_EXHAUSTED_KEY_PREFIX = "exhausted_until_"; // e.g. exhausted_until_0 → timestamp
const EXHAUSTION_SAFETY_BUFFER = 120_000; // +2 minutes buffer after official reset

// Project ID caching per credential
const KV_PROJECT_ID_PREFIX = "project_id_"; // e.g. project_id_0 → project-id-for-credential-0

/**
 * Handles OAuth2 authentication and Google Code Assist API communication.
 * Manages token caching, refresh, and API calls.
 */
export class AuthManager {
	private env: Env;
	private accessToken: string | null = null;
	private credsIndex: number = 0;
	private credsHash: number = 0;
	private credentials: string[] = [];

	constructor(env: Env) {
		this.env = env;
	}

	// KV-based exhaustion tracking methods
	private async markCredentialExhausted(index: number, resetIso: string): Promise<void> {
		const resetTime = new Date(resetIso).getTime() + EXHAUSTION_SAFETY_BUFFER;
		const key = `${KV_EXHAUSTED_KEY_PREFIX}${index}`;
		await this.env.GEMINI_CLI_KV.put(key, resetTime.toString(), {
			expirationTtl: Math.floor((resetTime - Date.now()) / 1000) + 3600 // keep entry a bit longer
		});
		console.log(`Credential ${index} marked exhausted until ${new Date(resetTime).toISOString()}`);
	}

	private async isCredentialExhausted(index: number): Promise<boolean> {
		const key = `${KV_EXHAUSTED_KEY_PREFIX}${index}`;
		const value = await this.env.GEMINI_CLI_KV.get(key);
		if (!value) return false;
		const until = parseInt(value, 10);
		const exhausted = Date.now() < until;
		if (!exhausted) {
			await this.env.GEMINI_CLI_KV.delete(key); // cleanup
		}
		return exhausted;
	}

	private async getNextViableCredentialIndex(currentIndex: number): Promise<number> {
		const total = this.credentials.length;
		let attempts = 0;
		let next = currentIndex;

		while (attempts < total) {
			next = next >= total - 1 ? 0 : next + 1;
			attempts++;
			if (!await this.isCredentialExhausted(next)) {
				return next;
			}
		}
		// All exhausted → return the one that recovers soonest (still bad, but best effort)
		return next;
	}

	/**
	 * Initializes authentication using OAuth2 credentials with KV storage caching.
	 */
	public async initializeAuth(): Promise<void> {
		if (this.credentials.length == 0)
			throw new Error("`GCP_SERVICE_ACCOUNT_*` environment variable not set. Please provide OAuth2 credentials JSON.");

		// Parse original credentials from environment.
		const oauth2Creds: OAuth2Credentials = JSON.parse(this.credentials[this.credsIndex]);
		this.credsHash = hashString(oauth2Creds.id_token);

		try {
			// First, try to get a cached token from KV storage
			let cachedTokenData = null;

			try {
				const cachedToken = await this.env.GEMINI_CLI_KV.get(`${KV_TOKEN_KEY}_${this.credsHash}`, "json");
				if (cachedToken) {
					cachedTokenData = cachedToken as CachedTokenData;
					console.log("Found cached token in KV storage");
				}
			} catch (kvError) {
				console.log("No cached token found in KV storage or KV error:", kvError);
			}

			// Check if cached token is still valid (with buffer)
			if (cachedTokenData) {
				const timeUntilExpiry = cachedTokenData.expiry_date - Date.now();
				if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
					this.accessToken = cachedTokenData.access_token;
					console.log(`Using cached token, valid for ${Math.floor(timeUntilExpiry / 1000)} more seconds`);
					return;
				}
				console.log("Cached token expired or expiring soon");
			}

			// Check if the original token is still valid
			const timeUntilExpiry = oauth2Creds.expiry_date - Date.now();
			if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
				// Original token is still valid, cache it and use it
				this.accessToken = oauth2Creds.access_token;
				console.log(`Original token is valid for ${Math.floor(timeUntilExpiry / 1000)} more seconds`);

				// Cache the token in KV storage
				await this.cacheTokenInKV(oauth2Creds.access_token, oauth2Creds.expiry_date);
				return;
			}

			// Both original and cached tokens are expired, refresh the token
			console.log("All tokens expired, refreshing...");
			await this.refreshAndCacheToken(oauth2Creds.refresh_token);
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			console.error("Failed to initialize authentication:", e);
			throw new Error("Authentication failed: " + errorMessage);
		}
	}

	public async rotateCredentials(reason: "normal" | "exhausted" = "normal", resetIso?: string): Promise<void> {
		// Load all credentials once
		if (this.credentials.length === 0) {
			this.credentials = Array.from({ length: 100 }, (_, i) => {
				const key = `GCP_SERVICE_ACCOUNT_${i}` as keyof Env;
				return (this.env[key] ?? "") as string;
			}).filter(s => s.length > 0);

			if (this.credentials.length === 0) {
				throw new Error("No GCP_SERVICE_ACCOUNT_* variables found");
			}
		}

		// Load current index
		const savedIndexStr = await this.env.GEMINI_CLI_KV.get(KV_CREDS_INDEX).catch(() => "0");
		this.credsIndex = Math.min(parseInt(savedIndexStr ?? "0", 10), this.credentials.length - 1);
		console.log(`Current credential index: ${this.credsIndex}`);

		let nextIndex: number;

		if (reason === "exhausted" && resetIso) {
			// Mark current one as dead
			await this.markCredentialExhausted(this.credsIndex, resetIso);
			// Find next healthy one
			nextIndex = await this.getNextViableCredentialIndex(this.credsIndex);
		} else {
			// Normal rotation — just skip exhausted ones
			nextIndex = await this.getNextViableCredentialIndex(this.credsIndex);
		}

		this.credsIndex = nextIndex;
		await this.env.GEMINI_CLI_KV.put(KV_CREDS_INDEX, nextIndex.toString());
		console.log(`Rotated credentials → ${nextIndex} (${reason === "exhausted" ? "skipped exhausted" : "normal"})`);

		// Reset token state so initializeAuth() runs fresh for new credential
		this.accessToken = null;
		this.credsHash = 0;
	}

	/**
	 * Refresh the OAuth token and cache it in KV storage.
	 */
	private async refreshAndCacheToken(refreshToken: string): Promise<void> {
		console.log("Refreshing OAuth token...");

		const refreshResponse = await fetch(OAUTH_REFRESH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			},
			body: new URLSearchParams({
				client_id: OAUTH_CLIENT_ID,
				client_secret: OAUTH_CLIENT_SECRET,
				refresh_token: refreshToken,
				grant_type: "refresh_token"
			})
		});

		if (!refreshResponse.ok) {
			const errorText = await refreshResponse.text();
			console.error("Token refresh failed:", errorText);
			throw new Error(`Token refresh failed: ${errorText}`);
		}

		const refreshData = (await refreshResponse.json()) as TokenRefreshResponse;
		this.accessToken = refreshData.access_token;

		// Calculate expiry time (typically 1 hour from now)
		const expiryTime = Date.now() + refreshData.expires_in * 1000;

		console.log("Token refreshed successfully");
		console.log(`New token expires in ${refreshData.expires_in} seconds`);

		// Cache the new token in KV storage
		await this.cacheTokenInKV(refreshData.access_token, expiryTime);
	}

	/**
	 * Cache the access token in KV storage.
	 */
	private async cacheTokenInKV(accessToken: string, expiryDate: number): Promise<void> {
		try {
			const tokenData = {
				access_token: accessToken,
				expiry_date: expiryDate,
				cached_at: Date.now()
			};

			// Cache for slightly less than the token expiry to be safe
			const ttlSeconds = Math.floor((expiryDate - Date.now()) / 1000) - 300; // 5 minutes buffer

			if (ttlSeconds > 0) {
				await this.env.GEMINI_CLI_KV.put(`${KV_TOKEN_KEY}_${this.credsHash}`, JSON.stringify(tokenData), {
					expirationTtl: ttlSeconds
				});
				console.log(`Token cached in KV storage with TTL of ${ttlSeconds} seconds`);
			} else {
				console.log("Token expires too soon, not caching in KV");
			}
		} catch (kvError) {
			console.error("Failed to cache token in KV storage:", kvError);
			// Don't throw an error here as the token is still valid, just not cached
		}
	}

	/**
	 * Clear cached token from KV storage.
	 */
	public async clearTokenCache(): Promise<void> {
		try {
			await this.env.GEMINI_CLI_KV.delete(`${KV_TOKEN_KEY}_${this.credsHash}`);
			console.log("Cleared cached token from KV storage");
		} catch (kvError) {
			console.log("Error clearing KV cache:", kvError);
		}
	}

	/**
	 * Get cached token info from KV storage.
	 */
	public async getCachedTokenInfo(): Promise<TokenCacheInfo> {
		try {
			const cachedToken = await this.env.GEMINI_CLI_KV.get(`${KV_TOKEN_KEY}_${this.credsHash}`, "json");
			if (cachedToken) {
				const tokenData = cachedToken as CachedTokenData;
				const timeUntilExpiry = tokenData.expiry_date - Date.now();

				return {
					cached: true,
					cached_at: new Date(tokenData.cached_at).toISOString(),
					expires_at: new Date(tokenData.expiry_date).toISOString(),
					time_until_expiry_seconds: Math.floor(timeUntilExpiry / 1000),
					is_expired: timeUntilExpiry < 0
					// Removed token_preview for security
				};
			}
			return { cached: false, message: "No token found in cache" };
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			return { cached: false, error: errorMessage };
		}
	}

	/**
	 * A generic method to call a Code Assist API endpoint.
	 */
	public async callEndpoint(method: string, body: Record<string, unknown>, isRetry: boolean = false): Promise<unknown> {
		await this.initializeAuth();

		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.accessToken}`
			},
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			if (response.status === 401 && !isRetry) {
				console.log("Got 401 error, clearing token cache and retrying...");
				this.accessToken = null; // Clear cached token
				await this.clearTokenCache(); // Clear KV cache
				await this.initializeAuth(); // This will refresh the token
				return this.callEndpoint(method, body, true); // Retry once
			}
			const errorText = await response.text();
			throw new Error(`API call failed with status ${response.status}: ${errorText}`);
		}

		return response.json();
	}

	/**
	 * A generic method to call a Code Assist API endpoint with retry logic for MCP failures.
	 */
	public async callEndpointWithRetry(
		method: string,
		body: Record<string, unknown>,
		maxRetries: number = 3,
		baseDelay: number = 1000
	): Promise<unknown> {
		let lastError: Error | null = null;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await this.initializeAuth();

				const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.accessToken}`
					},
					body: JSON.stringify(body)
				});

				if (!response.ok) {
					// Handle 401 with a single retry
					if (response.status === 401 && attempt === 1) {
						console.log("Got 401 error, clearing token cache and retrying...");
						this.accessToken = null;
						await this.clearTokenCache();
						await this.initializeAuth();
						continue; // Retry with fresh token
					}
					
					const errorText = await response.text();
					
					// Special handling for MCP service errors (500 errors from Gemini Code Assist)
					if (response.status === 500 && method === "loadCodeAssist") {
						console.log(`MCP service error on attempt ${attempt}: ${errorText}`);
						lastError = new Error(`MCP service unavailable: ${errorText}`);
						
						if (attempt < maxRetries) {
							const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
							console.log(`Retrying in ${delay}ms...`);
							await new Promise(resolve => setTimeout(resolve, delay));
							continue;
						}
					}
					
					throw new Error(`API call failed with status ${response.status}: ${errorText}`);
				}

				return response.json();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				if (attempt < maxRetries) {
					const delay = baseDelay * Math.pow(2, attempt - 1);
					console.log(`Attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}
		}
		
		throw lastError || new Error(`All ${maxRetries} attempts failed for ${method}`);
	}

	/**
	 * Cache the discovered project ID for the current credential.
	 */
	public async cacheProjectId(projectId: string): Promise<void> {
		try {
			const key = `${KV_PROJECT_ID_PREFIX}${this.credsIndex}`;
			await this.env.GEMINI_CLI_KV.put(key, projectId);
			console.log(`Cached project ID '${projectId}' for credential ${this.credsIndex}`);
		} catch (kvError) {
			console.error("Failed to cache project ID in KV storage:", kvError);
			// Don't throw an error here as the project ID can still be used
		}
	}

	/**
	 * Get cached project ID for the current credential.
	 */
	public async getCachedProjectId(): Promise<string | null> {
		try {
			const key = `${KV_PROJECT_ID_PREFIX}${this.credsIndex}`;
			const projectId = await this.env.GEMINI_CLI_KV.get(key);
			if (projectId) {
				console.log(`Found cached project ID '${projectId}' for credential ${this.credsIndex}`);
				return projectId;
			}
		} catch (kvError) {
			console.log("No cached project ID found or KV error:", kvError);
		}
		return null;
	}

	/**
	 * Clear cached project ID for the current credential.
	 */
	public async clearCachedProjectId(): Promise<void> {
		try {
			const key = `${KV_PROJECT_ID_PREFIX}${this.credsIndex}`;
			await this.env.GEMINI_CLI_KV.delete(key);
			console.log(`Cleared cached project ID for credential ${this.credsIndex}`);
		} catch (kvError) {
			console.log("Error clearing cached project ID:", kvError);
		}
	}

	/**
	 * Get the current credential index (for debugging purposes).
	 */
	public getCurrentCredentialIndex(): number {
		return this.credsIndex;
	}

	/**
	 * Get the current access token.
	 */
	public getAccessToken(): string | null {
		return this.accessToken;
	}
}
