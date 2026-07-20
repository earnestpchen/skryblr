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
          max_tokens: 1536,
          system: `You are writing the Introduction section of a peer-reviewed academic paper on the given topic. Follow standard academic Introduction conventions: establish context, summarize relevant findings, and frame why the topic matters — written in formal, third-person academic prose, not a casual explainer.

MANDATORY: You must call the search tool at least once before writing anything, and base every factual claim strictly on what the search results return. Do not rely on prior knowledge for facts, statistics, or findings — only on what you retrieve.

CITATION FORMAT (required, not optional):
- Every factual claim, statistic, or finding must be followed immediately by a bracketed number citing its source, e.g. "Recent studies show X [1]." or "This mechanism was first described in 2019 [2]."
- Reuse the same bracket number when citing the same source again.
- Number sources in the order they are first cited (starting at [1]).
- After the Introduction text, add a blank line, then the heading "References" on its own line, then a numbered list — one line per source — formatted exactly as:
1. Title — URL
2. Title — URL
- Every number that appears in brackets in the text must have a matching entry in References, and vice versa. Never fabricate a title or URL; use only what the search tool actually returned.

Target length for the Introduction text itself (not counting the References list): approximately ${wordCount} words. Do not include a title, headers, or any preamble like "Here is the introduction" — begin directly with the first sentence of the Introduction.`,
          messages: [{ role: "user", content: `Topic: ${query}` }],
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
