import hmac

from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings


def _matches(candidate: str | None, expected: str) -> bool:
    # Constant-time comparison so the secret can't be guessed from response timing.
    return bool(candidate) and hmac.compare_digest(candidate.encode(), expected.encode())


def verify_vapi_webhook(
    authorization: str | None = Header(default=None),
    x_vapi_secret: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """Vapi sends the shared secret as `Authorization: Bearer <secret>` (credential)
    or `X-Vapi-Secret: <secret>` (legacy server.secret). Accept either."""
    expected = settings.vapi_webhook_secret
    if not expected:
        # Refuse to run open: an unset secret must never mean "accept everything".
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook secret is not configured")
    bearer = None
    if authorization:
        bearer = authorization[7:] if authorization.lower().startswith("bearer ") else authorization
    if _matches(bearer, expected) or _matches(x_vapi_secret, expected):
        return
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook credentials")


def verify_api_key(
    x_api_key: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = settings.leads_api_key
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Leads API key is not configured")
    if not _matches(x_api_key, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")
