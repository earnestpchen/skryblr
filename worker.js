export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const query = (body.query || "").trim();
    const engine = body.engine || "google";
    const wordCount = Number(body.wordCount) > 0 ? Number(body.wordCount) : 150;

    if (!query) {
      return jsonResponse({ error: "Missing query" }, 400);
    }

    // Map each engine to the domains Claude's web search is allowed to use
    const domainMap = {
      google: null, // unrestricted web search
      scholar: ["scholar.google.com"],
      pubmed: ["pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov"]
    };
    const allowedDomains = domainMap[engine] || null;

    const tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {})
      }
    ];

    try {
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: `Search the web to answer the user's question using the available search tool. Keep your final answer to approximately ${wordCount} words. Be direct and skip preamble.`,
          messages: [{ role: "user", content: query }],
          tools
        })
      });

      const data = await anthropicRes.json();

      if (!anthropicRes.ok) {
        return jsonResponse({ error: data.error?.message || "Anthropic API error" }, anthropicRes.status);
      }

      const text = (data.content || [])
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
        .trim();

      return jsonResponse({ text: text || "(no answer returned)" });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

function corsHeaders() {
  return {
    // For production, replace "*" with your actual GitHub Pages URL,
    // e.g. "https://yourusername.github.io"
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
