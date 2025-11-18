import { Hono } from "hono";
import { Env } from "../types";
import { AuthManager } from "../auth";
import { GeminiApiClient } from "../gemini-client";

/**
 * Debug and testing routes for troubleshooting authentication and API functionality.
 */
export const DebugRoute = new Hono<{ Bindings: Env }>();

// Check KV cache status
DebugRoute.get("/cache", async (c) => {
	try {
		const authManager = new AuthManager(c.env);
		const cacheInfo = await authManager.getCachedTokenInfo();

		// Remove sensitive information from the response
		const sanitizedInfo = {
			status: "ok",
			cached: cacheInfo.cached,
			cached_at: cacheInfo.cached_at,
			expires_at: cacheInfo.expires_at,
			time_until_expiry_seconds: cacheInfo.time_until_expiry_seconds,
			is_expired: cacheInfo.is_expired,
			message: cacheInfo.message
			// Explicitly exclude token_preview and any other sensitive data
		};

		return c.json(sanitizedInfo);
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return c.json(
			{
				status: "error",
				message: errorMessage
			},
			500
		);
	}
});

// Simple token test endpoint
DebugRoute.post("/token-test", async (c) => {
	try {
		console.log("Token test endpoint called");
		const authManager = new AuthManager(c.env);

		// Test authentication only
		await authManager.initializeAuth();
		console.log("Token test passed");

		return c.json({
			status: "ok",
			message: "Token authentication successful"
		});
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Token test error:", e);
		return c.json(
			{
				status: "error",
				message: errorMessage
				// Removed stack trace for security
			},
			500
		);
	}
});

// Full functionality test endpoint
DebugRoute.post("/test", async (c) => {
	try {
		console.log("Test endpoint called");
		const authManager = new AuthManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, authManager);

		// Test authentication
		await authManager.initializeAuth();
		console.log("Auth test passed");

		// Test project discovery with enhanced error details
		let projectId: string;
		let projectDiscoveryInfo = {
			available: false,
			method: "unknown",
			error: null as string | null,
			retry_count: 0
		};

		try {
			projectId = await geminiClient.discoverProjectId();
			projectDiscoveryInfo.available = true;
			projectDiscoveryInfo.method = "success";
			console.log("Project discovery test passed");
		} catch (discoveryError: unknown) {
			const errorMessage = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
			projectDiscoveryInfo.error = errorMessage;
			
			// Determine which method was attempted
			if (c.env.GEMINI_PROJECT_ID) {
				projectDiscoveryInfo.method = "environment_variable";
			} else if (c.env.DISABLE_MCP_DISCOVERY === "true") {
				projectDiscoveryInfo.method = "disabled_via_env";
			} else {
				projectDiscoveryInfo.method = "mcp_discovery_failed";
			}
			
			console.log("Project discovery test failed:", errorMessage);
			projectId = "unavailable"; // This will cause subsequent API calls to fail appropriately
		}

		// Test token caching
		const tokenInfo = await authManager.getCachedTokenInfo();

		return c.json({
			status: "ok",
			message: "Authentication and project discovery test completed",
			authentication: {
				working: true,
				token_cached: tokenInfo.cached,
				token_expiry_info: tokenInfo.cached ? {
					cached_at: tokenInfo.cached_at,
					expires_at: tokenInfo.expires_at,
					time_until_expiry_seconds: tokenInfo.time_until_expiry_seconds
				} : null
			},
			project_discovery: projectDiscoveryInfo,
			configuration: {
				has_project_id_env: !!c.env.GEMINI_PROJECT_ID,
				mcp_discovery_disabled: c.env.DISABLE_MCP_DISCOVERY === "true",
				has_openai_key: !!c.env.OPENAI_API_KEY
			}
		});
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Test endpoint error:", e);
		return c.json(
			{
				status: "error",
				message: errorMessage,
				authentication: {
					working: false,
					error: "Authentication failed - check your GCP_SERVICE_ACCOUNT credentials"
				}
			},
			500
		);
	}
});
