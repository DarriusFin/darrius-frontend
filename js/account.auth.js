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

  function updateAccountView(authenticated, userId) {
    const signedIn = authenticated === true;
    const hasAccess =
      signedIn &&
      window.__ENTITLEMENT__?.has_access === true;

    const loginFields = $("accountLoginFields");
    const signedInSummary = $("accountSignedInSummary");
    const signedInUser = $("accountSignedInUser");

    const emailField = $("accountEmailField");
    const planField = $("accountPlanField");
    const checkoutActions = $("accountCheckoutActions");
    const sessionActions = $("accountSessionActions");

    const manageBtn = $("manageBtn");

    if (loginFields) {
      loginFields.style.display = signedIn ? "none" : "";
    }

    if (signedInSummary) {
      signedInSummary.style.display = signedIn ? "" : "none";
    }

    if (signedInUser) {
      signedInUser.textContent = signedIn
        ? String(userId || "—")
        : "—";
    }

    // Show checkout whenever the account does not have active access.
    // Guests can still start a new subscription.
    const showCheckout = !hasAccess;

    if (emailField) {
      emailField.style.display = showCheckout ? "" : "none";
    }

    if (planField) {
      planField.style.display = showCheckout ? "" : "none";
    }

    if (checkoutActions) {
      checkoutActions.style.display = showCheckout ? "" : "none";
    }

    if (sessionActions) {
      sessionActions.style.display = signedIn ? "" : "none";
      sessionActions.style.gridTemplateColumns =
        hasAccess ? "1fr 1fr" : "1fr";
    }

    if (manageBtn) {
      manageBtn.style.display = hasAccess ? "" : "none";
    }
  }

  function setAccountMeta(text) {
    const el = $("accountMeta");
    if (el) {
      el.textContent = text;
    }
  }

  function emitAuthChanged(authenticated, userId = null) {
    window.dispatchEvent(
      new CustomEvent("darrius:auth-changed", {
        detail: {
          authenticated: authenticated === true,
          user_id: userId,
        },
      })
    );
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
        setAccountMeta("SIGNED IN");
        updateAccountView(true, userId);

        const userIdInput = $("userId");

        if (userIdInput) {
          userIdInput.value = userId;
        }

        window.__AUTH_USER_ID__ = userId;

        emitAuthChanged(true, userId);

        return {
          authenticated: true,
          user_id: userId,
        };
      }

      window.__AUTH_USER_ID__ = null;
      setStatus("Not signed in");
      setAccountMeta("GUEST");
      updateAccountView(false, null);
      emitAuthChanged(false, null);

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
      setAccountMeta("GUEST");
      updateAccountView(false, null);
      emitAuthChanged(false, null);

      return {
        authenticated: false,
      };
    }
  }

  async function signOut() {
    const button = $("signOutBtn");

    if (button) {
      button.disabled = true;
      button.textContent = "Signing Out...";
    }

    try {
      const { response } = await fetchJSON(
        "/api/auth/logout",
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        throw new Error(`Logout failed: ${response.status}`);
      }

      window.__AUTH_USER_ID__ = null;
      window.__ENTITLEMENT__ = null;

      const userIdInput = $("userId");
      const emailInput = $("email");

      if (userIdInput) {
        userIdInput.value = "";
      }

      if (emailInput) {
        emailInput.value = "";
      }

      showCodeField(false);

      setStatus("Not signed in");
      setAccountMeta("GUEST");
      updateAccountView(false, null);

      emitAuthChanged(false, null);
    } catch (error) {
      console.error(
        "[AccountAuth] logout failed",
        error
      );

      setStatus(
        "Unable to sign out. Please try again."
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Sign Out";
      }
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
    const signOutButton = $("signOutBtn");

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

    if (signOutButton) {
      signOutButton.addEventListener(
        "click",
        signOut
      );
    }

    window.addEventListener(
      "darrius:subscription-status",
      (event) => {
        const policy = event?.detail || null;

        if (
          window.__AUTH_USER_ID__ &&
          policy
        ) {
          updateAccountView(
            true,
            window.__AUTH_USER_ID__
          );
        }
      }
    );

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
    signOut,
  };
})();