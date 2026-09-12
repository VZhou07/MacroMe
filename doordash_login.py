"""Start a fresh Steel browser and sign in to DoorDash once per invocation."""

import argparse
import getpass
import os
import re
import sys
import time
from urllib.parse import urlencode, urlsplit


class LoginError(Exception):
    """Safe, credential-free message suitable for printing."""


def secret(name, prompt):
    value = os.environ.pop(name, None)
    if not value:
        if not sys.stdin.isatty():
            raise LoginError(f"Set {name} in the environment before running unattended.")
        value = getpass.getpass(prompt)
    if not value:
        raise LoginError(f"{name} cannot be empty.")
    return value


def trusted_url(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    return parsed.scheme == "https" and (host == "doordash.com" or host.endswith(".doordash.com"))


def visible(locator):
    return locator.count() > 0 and locator.first.is_visible()


def login_frame(page):
    # The login form is sometimes embedded in the Login/Signup iframe.
    for frame in page.frames:
        if trusted_url(frame.url) and visible(frame.locator('input[type="password"]')):
            return frame
    return None


def signed_in(page):
    # A redirect or a disappearing form alone is not proof of authentication.
    if not trusted_url(page.url) or login_frame(page) is not None:
        return False
    return visible(page.get_by_role("button", name=re.compile(r"^(log out|sign out)$", re.I))) or visible(
        page.get_by_role("link", name=re.compile(r"^(log out|sign out)$", re.I))
    )


def sign_in(page, email, password, verification_seconds):
    page.goto("https://www.doordash.com/", wait_until="domcontentloaded", timeout=60000)
    deadline = time.monotonic() + 45
    opened = False
    frame = None
    while time.monotonic() < deadline:
        frame = login_frame(page)
        if frame:
            break
        link = page.get_by_role("link", name="Sign In", exact=True)
        if not opened and visible(link):
            link.first.click()
            opened = True
        page.wait_for_timeout(500)
    if frame is None:
        raise LoginError("DoorDash's email/password form did not appear. Inspect the live browser; no credentials were submitted.")
    # Never fill a form on an unexpected origin.
    if not trusted_url(page.url) or not trusted_url(frame.url):
        raise LoginError("The login form is not on a DoorDash HTTPS origin.")
    frame.get_by_role("textbox", name="Email", exact=True).fill(email)
    frame.locator('input[type="password"]').fill(password)
    frame.get_by_role("button", name="Continue to Sign In", exact=True).click()
    print("Login submitted once. Complete any verification in the live browser.", flush=True)
    print("If needed, open DoorDash's account menu so its Sign Out control is visible.", flush=True)
    deadline = time.monotonic() + verification_seconds
    menu_opened = False
    while time.monotonic() < deadline:
        if signed_in(page):
            return
        for current in page.frames:
            if not trusted_url(current.url):
                continue
            error = current.get_by_text(re.compile(r"incorrect password|invalid password|invalid email or password|too many (login )?attempts", re.I))
            if visible(error):
                raise LoginError("DoorDash rejected the login or rate-limited it. No automatic retry was made.")
        # Open the account navigation only after the login form disappears.
        if login_frame(page) is None and not menu_opened:
            menu = page.get_by_role("button", name=re.compile(r"^(Open Menu|Account|My Account)$", re.I))
            if visible(menu):
                menu.first.click()
                menu_opened = True
        page.wait_for_timeout(1000)
    raise LoginError("Login could not be verified before the timeout. Verification may still be required, or DoorDash's UI may have changed.")


def run(args):
    # Read before importing Playwright, which starts a child process. Do not pass
    # credentials as command-line arguments or persist cookies/passwords locally.
    api_key = secret("STEEL_API_KEY", "Steel API key (hidden): ")
    email = secret("DOORDASH_EMAIL", "DoorDash email (hidden): ")
    password = secret("DOORDASH_PASSWORD", "DoorDash password (hidden): ")
    os.environ.pop("DEBUG", None)  # Playwright debug logs can contain form values.
    os.environ.pop("PWDEBUG", None)
    os.environ.pop("STEEL_LOG", None)
    from steel import Steel
    from playwright.sync_api import sync_playwright

    with Steel(steel_api_key=api_key, max_retries=0) as client:
        session = None
        try:
            session = client.sessions.create(
                api_timeout=(args.verification_timeout + args.hold_seconds + 120) * 1000,
                inactivity_timeout=0,
            )
            print(f"Watch your browser: https://app.steel.dev/sessions/{session.id}", flush=True)
            endpoint = "wss://connect.steel.dev?" + urlencode({"apiKey": api_key, "sessionId": session.id})
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(endpoint, timeout=60000)
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.new_page()
                page.set_default_timeout(15000)
                sign_in(page, email, password, args.verification_timeout)
                print("DoorDash login verified: Sign Out is visible.", flush=True)
                # Add subsequent authorized browser tasks here, while page is authenticated.
                if args.hold_seconds:
                    print(f"Browser stays available for {args.hold_seconds} seconds; Ctrl+C closes it early.", flush=True)
                    page.wait_for_timeout(args.hold_seconds * 1000)
        finally:
            if session is not None:
                try:
                    client.sessions.release(session.id)
                    print("Steel session released.", flush=True)
                except Exception:
                    raise LoginError("Session release failed. Stop it at https://app.steel.dev; the configured session timeout still applies.") from None


def positive(value):
    number = int(value)
    if number < 1 or number > 1800:
        raise argparse.ArgumentTypeError("Use a value between 1 and 1800 seconds.")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verification-timeout", type=positive, default=180)
    parser.add_argument("--hold-seconds", type=int, choices=range(0, 1801), metavar="0..1800", default=120)
    args = parser.parse_args()
    try:
        run(args)
        return 0
    except LoginError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Stopped.", file=sys.stderr)
        return 130
    except Exception:
        # SDK/Playwright exceptions may include authenticated URLs and form values.
        print("Automation failed. Run steel doctor for auth/API diagnostics and inspect the session replay. Raw errors are suppressed to protect credentials.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
