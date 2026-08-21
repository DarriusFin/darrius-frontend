(function () {
  "use strict";

  const API_BASE =
    (window.__API_BASE__ || window.API_BASE || "").trim() ||
    "https://darrius-api.onrender.com";

  const $ = (id) => document.getElementById(id);

  function setStatus(text) {
    const el = $("authStatusText");
    if (el) el.textContent = text;
  }

  function showCodeField(show) {
    const el = $("verificationCodeField");
    if (!el) return;

    el.style.display = show ? "" : "none";
  }

  async function fetchJSON(path, options) {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = {
        ok: false,
        error: "invalid_server_response",
      };
    }

    return {
      response,
      data,
    };
  }

  async function refreshSession() {
    try {
      const response = await fetch(
        `${API_BASE}/api/auth/session`,
        {
          method: "GET",
          credentials: "include",
        }
      );

      const text = await response.text();

      let data = {};

      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {}

      if (
        response.ok &&
        data?.authenticated === true &&
        data?.user_id
      ) {
        const userId = String(data.user_id).trim();

        setStatus(`Signed in: ${userId}`);

        const userIdInput = $("userId");

        if (userIdInput) {
          userIdInput.value = userId;
        }

        window.__AUTH_USER_ID__ = userId;

        window.dispatchEvent(
          new CustomEvent("darrius:auth-changed", {
            detail: {
              authenticated: true,
              user_id: userId,
            },
          })
        );

        return {
          authenticated: true,
          user_id: userId,
        };
      }

      window.__AUTH_USER_ID__ = null;

      setStatus("Not signed in");

      return {
        authenticated: false,
      };
    } catch (error) {
      console.error(
        "[AccountAuth] session check failed",
        error
      );

      window.__AUTH_USER_ID__ = null;

      setStatus("Unable to check sign-in status");

      return {
        authenticated: false,
      };
    }
  }

  async function sendVerificationCode() {
    const userId = String(
      $("userId")?.value || ""
    ).trim();

    if (!userId) {
      setStatus("Enter your User ID first.");
      $("userId")?.focus();
      return;
    }

    const button = $("sendVerifyBtn");

    if (button) {
      button.disabled = true;
      button.textContent = "Sending...";
    }

    setStatus("Requesting verification code...");

    try {
      const { response } = await fetchJSON(
        "/api/auth/migration/request",
        {
          method: "POST",
          body: JSON.stringify({
            user_id: userId,
          }),
        }
      );

      if (response.ok) {
        showCodeField(true);

        setStatus(
          "If this account is eligible, a verification code has been sent to the email on file."
        );

        $("verificationCode")?.focus();
      } else {
        setStatus(
          "Unable to send a verification code. Please try again later."
        );
      }
    } catch (error) {
      console.error(
        "[AccountAuth] verification request failed",
        error
      );

      setStatus(
        "Unable to send a verification code. Please try again later."
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent =
          "Send Verification Code";
      }
    }
  }

  async function verifyCode() {
    const userId = String(
      $("userId")?.value || ""
    ).trim();

    const code = String(
      $("verificationCode")?.value || ""
    ).trim();

    if (!userId) {
      setStatus("Enter your User ID first.");
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      setStatus(
        "Enter the 6-digit verification code."
      );
      $("verificationCode")?.focus();
      return;
    }

    const button = $("verifyCodeBtn");

    if (button) {
      button.disabled = true;
      button.textContent = "Verifying...";
    }

    setStatus("Verifying...");

    try {
      const { response, data } = await fetchJSON(
        "/api/auth/migration/verify",
        {
          method: "POST",
          body: JSON.stringify({
            user_id: userId,
            code,
          }),
        }
      );

      if (
        !response.ok ||
        data?.authenticated !== true
      ) {
        setStatus(
          "Verification failed. Check the code and try again."
        );
        return;
      }

      const session = await refreshSession();

      if (session.authenticated) {
        showCodeField(false);

        const codeInput = $("verificationCode");

        if (codeInput) {
          codeInput.value = "";
        }
      } else {
        setStatus(
          "Verification succeeded, but the session could not be confirmed."
        );
      }
    } catch (error) {
      console.error(
        "[AccountAuth] verification failed",
        error
      );

      setStatus(
        "Verification failed. Please try again."
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Verify";
      }
    }
  }

  function attach() {
    const sendButton = $("sendVerifyBtn");
    const verifyButton = $("verifyCodeBtn");
    const codeInput = $("verificationCode");

    if (sendButton) {
      sendButton.addEventListener(
        "click",
        sendVerificationCode
      );
    }

    if (verifyButton) {
      verifyButton.addEventListener(
        "click",
        verifyCode
      );
    }

    if (codeInput) {
      codeInput.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter") {
            verifyCode();
          }
        }
      );
    }

    refreshSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      attach
    );
  } else {
    attach();
  }

  window.AccountAuth = {
    refreshSession,
    sendVerificationCode,
    verifyCode,
  };
})();