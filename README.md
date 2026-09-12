# DoorDash login with Steel

Run from PowerShell in this repository:

```powershell
.\login-doordash.ps1
```

Or from Ubuntu WSL:

```sh
.venv/bin/python doordash_login.py
```

Every invocation creates a fresh Steel cloud browser and submits DoorDash's email/password form once. A live viewer link is printed. Login is reported as successful only when a Sign Out / Log Out control is visible. DoorDash can require a verification code or CAPTCHA; complete it in the viewer. The script cannot guarantee unattended login when DoorDash requires verification.

## Credentials

The script reads `STEEL_API_KEY`, `DOORDASH_EMAIL`, and `DOORDASH_PASSWORD` from its WSL environment, or prompts for each missing value without echoing it. It does not reuse the Steel CLI's saved key. Obtain a Steel API key from https://app.steel.dev/settings/api-keys if needed.

For repeated unattended triggers, inject those three environment variables from your secret manager into the **WSL process**. Windows environment variables are not automatically forwarded by the launcher. Do not put credentials in this repository, command-line arguments, or shell history. No `.env` file is required or loaded.

Credentials are sent to Steel/DoorDash to perform the login. The script saves no credentials, cookies, screenshots, traces, or browser profiles locally, and suppresses raw exceptions that could expose secrets. Steel manages cloud session recordings; treat dashboard access as sensitive.

## Session lifetime

By default, allow 180 seconds for verification and hold the successful browser open for 120 seconds, then release it. Ctrl+C also releases the session. Each run logs in afresh rather than loading a saved profile. Extend the inspection window with:

```powershell
.\login-doordash.ps1 --verification-timeout 300 --hold-seconds 600
```

Use `--hold-seconds 0` for a login check that releases immediately. Put subsequent automation at the marked point in `doordash_login.py` to use the authenticated page. The script does not order anything.

## Dependencies and checks

Dependencies are installed in `.venv` in WSL. To recreate the environment:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

No local browser download is needed. A failed login exits nonzero and is not retried. For Steel failures, run `steel doctor` and follow the reported fix; replays are at https://app.steel.dev. Successful real-account login requires your credentials and has not been validated by the repository's offline tests.

References: [Steel + Playwright](https://docs.steel.dev/integrations/playwright), [Steel Python SDK](https://github.com/steel-dev/steel-python).
