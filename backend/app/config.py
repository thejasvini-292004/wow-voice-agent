from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All credentials come from environment variables (or a local .env file)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    vapi_webhook_secret: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    leads_api_key: str = ""
    vapi_private_key: str = ""
    vapi_assistant_id: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
