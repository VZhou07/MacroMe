import os
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

from doordash_login import LoginError, run, secret, signed_in, trusted_url


class LoginTests(unittest.TestCase):
    def test_credentials_only_sent_to_https_doordash(self):
        for url in ("https://www.doordash.com/", "https://identity.doordash.com/login"):
            self.assertTrue(trusted_url(url))
        for url in ("http://www.doordash.com", "https://doordash.com.evil.test", "https://evil.test/?doordash.com", "about:blank"):
            self.assertFalse(trusted_url(url))

    def test_unattended_missing_secret_fails_without_prompt(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.stdin.isatty", return_value=False):
            with self.assertRaises(LoginError):
                secret("DOORDASH_PASSWORD", "Password: ")

    def test_secret_removed_from_child_process_environment(self):
        with patch.dict(os.environ, {"DOORDASH_PASSWORD": "test-only-value"}):
            self.assertEqual(secret("DOORDASH_PASSWORD", ""), "test-only-value")
            self.assertNotIn("DOORDASH_PASSWORD", os.environ)

    def test_redirect_does_not_count_as_login(self):
        page = Mock(url="https://www.doordash.com/home", frames=[])
        page.get_by_role.return_value.count.return_value = 0
        self.assertFalse(signed_in(page))

    def test_visible_signout_confirms_login(self):
        page = Mock(url="https://www.doordash.com/home", frames=[])
        page.get_by_role.return_value.count.return_value = 1
        page.get_by_role.return_value.first.is_visible.return_value = True
        self.assertTrue(signed_in(page))

    def test_password_form_prevents_false_success(self):
        frame = Mock(url="https://identity.doordash.com/login")
        frame.locator.return_value.count.return_value = 1
        frame.locator.return_value.first.is_visible.return_value = True
        page = Mock(url="https://www.doordash.com/", frames=[frame])
        self.assertFalse(signed_in(page))

    def test_cloud_session_released_on_failure_or_interrupt(self):
        for error in (LoginError("Login rejected"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                sdk = MagicMock()
                client = sdk.Steel.return_value.__enter__.return_value
                client.sessions.create.return_value.id = "test-session"
                playwright = MagicMock()
                modules = {"steel": sdk, "playwright": MagicMock(), "playwright.sync_api": playwright}
                args = SimpleNamespace(verification_timeout=1, hold_seconds=0)
                with patch.dict("sys.modules", modules), patch("doordash_login.secret", return_value="test-only"), patch("doordash_login.sign_in", side_effect=error), patch("builtins.print"):
                    with self.assertRaises(type(error)):
                        run(args)
                client.sessions.release.assert_called_once_with("test-session")

    def test_release_failure_is_not_reported_as_success(self):
        sdk = MagicMock()
        client = sdk.Steel.return_value.__enter__.return_value
        client.sessions.create.return_value.id = "test-session"
        client.sessions.release.side_effect = RuntimeError("sensitive internal error")
        modules = {"steel": sdk, "playwright": MagicMock(), "playwright.sync_api": MagicMock()}
        args = SimpleNamespace(verification_timeout=1, hold_seconds=0)
        with patch.dict("sys.modules", modules), patch("doordash_login.secret", return_value="test-only"), patch("doordash_login.sign_in"), patch("builtins.print"):
            with self.assertRaisesRegex(LoginError, "Session release failed"):
                run(args)


if __name__ == "__main__":
    unittest.main()
