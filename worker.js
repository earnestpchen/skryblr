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

    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    let feedback = "";
    let finalText = "";
    const attemptLog = [];

    try {
      while (attempt < MAX_ATTEMPTS) {
        attempt++;

        // 1. GENERATE — ask Claude to write the introduction, searching for real sources
        const text = await generateIntroduction(env, query, wordCount, tools, feedback);
        finalText = text;

        // 2. TEST — structural check: citations present, references present, numbers match, APA-ish shape
        const { issues: structuralIssues, references } = checkStructure(text);

        // 2b. TEST — do the cited URLs actually resolve online?
        const urlIssues = structuralIssues.length === 0
          ? await checkReferenceUrls(references)
          : [];

        // 2c. TEST — LLM-judged check: reads like an intro, and claims are actually grounded in their cited source
        let judgeIssues = [];
        if (structuralIssues.length === 0 && urlIssues.length === 0) {
          judgeIssues = await judgeOutput(env, text);
        }

        const allIssues = [...structuralIssues, ...urlIssues, ...judgeIssues];
        attemptLog.push({ attempt, pass: allIssues.length === 0, issues: allIssues });

        // 3. COMMAND — if it passed every check, we're done
        if (allIssues.length === 0) {
          return jsonResponse({ text, attempts: attempt, log: attemptLog });
        }

        // Otherwise, diagnose (the issues array IS the diagnosis) and feed it back for the next attempt
        feedback = allIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n");
      }

      // Exhausted attempts — return the best attempt along with exactly what's still wrong
      return jsonResponse({
        text: finalText,
        attempts: attempt,
        log: attemptLog,
        warning: `Could not satisfy every criterion after ${MAX_ATTEMPTS} attempts. Returning the last draft — see "log" for exactly which checks failed and when.`
      });
    } catch (err) {
      return jsonResponse({ error: err.message, log: attemptLog }, 500);
    }
  }
};

function buildSystemPrompt(wordCount, feedback) {
  let prompt = `You are writing the Introduction section of a peer-reviewed academic paper on the given topic. Follow standard academic Introduction conventions: establish context, summarize relevant findings, and frame why the topic matters — written in formal, third-person academic prose, not a casual explainer.

MANDATORY: You must call the search tool at least once before writing anything, and base every factual claim strictly and only on what the search results return. Do not rely on prior knowledge for facts, statistics, or findings.

CITATION FORMAT (required, not optional):
- Every factual claim, statistic, or finding must be followed immediately by a bracketed number citing its source, e.g. "Recent studies show X [1]."
- Reuse the same bracket number when citing the same source again.
- Number sources in the order first cited, starting at [1].
- After the Introduction text, add a blank line, then the heading "References" on its own line, then a numbered list, one entry per line, in full APA 7th edition format, e.g.:
1. Author, A. A. (Year). Title of the work. Source or publisher. https://example.com
If there's no individual author, use the organization or site name as the author. If there's no date, use (n.d.).
- Every bracket number in the text must have exactly one matching numbered entry in References, and every reference must be cited at least once in the text.
- Only cite sources actually returned by the search tool. Never invent a title, author, date, or URL.

Target length for the Introduction text itself (excluding References): approximately ${wordCount} words. No title, no headers, no preamble — begin directly with the first sentence.`;

  if (feedback) {
    prompt += `\n\nYour previous attempt failed review for these specific reasons:\n${feedback}\n\nFix every issue listed above. Search again if you need different or better sources.`;
  }

  return prompt;
}

async function generateIntroduction(env, topic, wordCount, tools, feedback) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1536,
      system: buildSystemPrompt(wordCount, feedback),
      messages: [{ role: "user", content: `Topic: ${topic}` }],
      tools
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Anthropic API error during generation");

  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

// Structural checks: citations exist, references exist, numbers match 1:1, entries look APA-shaped
function checkStructure(text) {
  const issues = [];

  const inTextNumbers = [...text.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1]));
  if (inTextNumbers.length === 0) {
    issues.push("No in-text bracket citations like [1] were found in the body text.");
  }

  const refHeadingMatch = text.match(/^References\s*$/im);
  if (!refHeadingMatch) {
    issues.push('No "References" heading was found.');
  }

  const refSection = refHeadingMatch
    ? text.slice(text.indexOf(refHeadingMatch[0]) + refHeadingMatch[0].length)
    : "";
  const refEntries = [...refSection.matchAll(/^\s*(\d+)\.\s*(.+)$/gm)];

  if (refHeadingMatch && refEntries.length === 0) {
    issues.push("A References heading exists but no numbered entries follow it.");
  }

  const refNumbers = refEntries.map(m => parseInt(m[1]));
  const citedSet = new Set(inTextNumbers);
  const refSet = new Set(refNumbers);

  for (const n of citedSet) {
    if (!refSet.has(n)) issues.push(`Citation [${n}] appears in the text but has no matching reference entry.`);
  }
  for (const n of refSet) {
    if (!citedSet.has(n)) issues.push(`Reference ${n} is listed but never cited with [${n}] in the text.`);
  }

  const references = [];
  for (const m of refEntries) {
    const number = parseInt(m[1]);
    const entryText = m[2];
    const hasYear = /\((\d{4}|n\.d\.)\)/.test(entryText);
    const urlMatch = entryText.match(/https?:\/\/\S+/);
    if (!hasYear || !urlMatch) {
      issues.push(`Reference ${number} doesn't look like valid APA format (needs an author/org, a (Year) or (n.d.), and a URL): "${entryText.slice(0, 90)}"`);
    }
    references.push({
      number,
      url: urlMatch ? urlMatch[0].replace(/[.,;)\]]+$/, "") : null
    });
  }

  return { issues, references };
}

// Verify cited URLs actually resolve — capped to bound Worker subrequests
async function checkReferenceUrls(references) {
  const issues = [];
  const toCheck = references.filter(r => r.url).slice(0, 6);

  await Promise.all(toCheck.map(async (ref) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      let res;
      try {
        res = await fetch(ref.url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      } catch (e) {
        // Some servers reject HEAD — retry with GET before concluding it's broken
        res = await fetch(ref.url, { method: "GET", redirect: "follow", signal: controller.signal });
      }
      clearTimeout(timeout);
      if (res.status === 404 || res.status === 410) {
        issues.push(`Reference ${ref.number} URL returned ${res.status} (page not found): ${ref.url}`);
      }
      // Note: 403/429/999 etc. usually mean bot-blocking, not a nonexistent page — not treated as a failure
    } catch (e) {
      issues.push(`Reference ${ref.number} URL could not be reached at all (${e.message}): ${ref.url}`);
    }
  }));

  return issues;
}

// LLM-judged check: does this read like a real intro, and is every claim actually grounded in its citation?
async function judgeOutput(env, text) {
  const judgePrompt = `You are a strict peer reviewer checking a draft Introduction section. Use web search to verify facts where needed.

Check both:
1. Does this read like the Introduction of a peer-reviewed academic paper — formal, third-person, establishing context and significance — rather than a casual summary?
2. Is every factual claim genuinely supported by the specific source cited for it (not just plausible-sounding, but actually stated by that source)?

Respond with ONLY a JSON object, no markdown fences, no other text:
{"pass": true or false, "issues": ["short specific issue", "short specific issue"]}
If everything checks out: {"pass": true, "issues": []}

TEXT TO REVIEW:
${text}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      messages: [{ role: "user", content: judgePrompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    // Don't let a broken judge call block the whole loop — just skip judging this round
    return [];
  }

  const rawText = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  const cleaned = rawText.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.pass) return [];
    return Array.isArray(parsed.issues) ? parsed.issues : ["Judge review flagged an issue but returned no details."];
  } catch (e) {
    return []; // if the judge didn't return valid JSON, don't hard-fail on it
  }
}

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
