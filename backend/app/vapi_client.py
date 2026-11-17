import httpx


def fetch_call(call_id: str, private_key: str) -> dict | None:
    """Reads a call from Vapi's REST API. Used only to pick up structured
    output that was not ready when the webhook fired."""
    try:
        res = httpx.get(
            f"https://api.vapi.ai/call/{call_id}",
            headers={"Authorization": f"Bearer {private_key}"},
            timeout=10,
        )
        return res.json() if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
