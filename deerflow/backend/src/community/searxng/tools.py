"""SearXNG web search tool for DeerFlow.

Drop-in replacement for the Tavily web_search_tool.  Uses a self-hosted
SearXNG instance (JSON API) so no external API key is needed.

Required env var:
    SEARXNG_URL  — base URL of the SearXNG instance (e.g. http://searxng:8080)
"""

import json
import os
import urllib.request
import urllib.parse

from langchain.tools import tool

from src.config import get_app_config

_DEFAULT_SEARXNG_URL = "http://searxng:8080"


def _get_searxng_url() -> str:
    """Resolve the SearXNG base URL from env or config.yaml extras."""
    url = os.environ.get("SEARXNG_URL")
    if url:
        return url.rstrip("/")
    config = get_app_config().get_tool_config("web_search")
    if config is not None and "searxng_url" in config.model_extra:
        return str(config.model_extra["searxng_url"]).rstrip("/")
    return _DEFAULT_SEARXNG_URL


@tool("web_search", parse_docstring=True)
def web_search_tool(query: str) -> str:
    """Search the web.

    Args:
        query: The query to search for.
    """
    config = get_app_config().get_tool_config("web_search")
    max_results = 5
    if config is not None and "max_results" in config.model_extra:
        max_results = config.model_extra.get("max_results")

    base = _get_searxng_url()
    params = urllib.parse.urlencode({
        "q": query,
        "format": "json",
        "categories": "general",
    })
    url = f"{base}/search?{params}"

    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())

    results = data.get("results", [])[:max_results]
    normalized = [
        {
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "snippet": r.get("content", ""),
        }
        for r in results
    ]
    return json.dumps(normalized, indent=2, ensure_ascii=False)
