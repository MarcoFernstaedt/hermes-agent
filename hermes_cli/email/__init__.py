"""Email module — Gmail behind a provider abstraction.

UI + agent both go through the shared Gmail service (hermes_cli.google.gmail),
which reads tokens from the encrypted store via the unified Google OAuth
manager. This package hosts the FastAPI router; the agent tools live alongside.
"""
