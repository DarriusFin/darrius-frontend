(function () {
  "use strict";

  const API_BASE = ((window.__API_BASE__ || window.API_BASE || "").trim() || "https://api.darrius.ai").replace(/\/+$/, '');

  let sessionVersion = 0;
  let authBusy = false;
  let sendBusy = false;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response, text;
    try {
      response = await fetch(API_BASE + path, {
        ...options, credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { ...(options?.body ? {'Content-Type': 'application/json'} : {}), ...(options?.headers || {}) },
      });
      text = await response.text();
    } finally { clearTimeout(timer); }

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
    const accountPageAction = $("accountPageAction");

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

    if (accountPageAction) {
      accountPageAction.style.display = signedIn ? "" : "none";
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
      emailField.style.display =
        "none";
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

  async function refreshSession(force = false) {
    if (authBusy && !force) return { authenticated: false, pending: true };
    const version = ++sessionVersion;
    try {
      const {response, data} = await fetchJSON('/api/auth/session', {method:'GET'});
      if (version !== sessionVersion) return {authenticated:false, stale:true};
      if ((!response.ok && response.status !== 401) || (response.ok && (data?.authenticated !== true || !data?.user_id))) throw new Error('session_unavailable');

      if (
        response.ok &&
        data?.authenticated === true &&
        data?.user_id
      ) {
        const userId = String(data.user_id).trim();

        const signedInTemplate =
          window.DARRIUS_T?.("signedInStatus") ||
          "Signed in: {user}";

        setStatus(
          signedInTemplate.replace(
            "{user}",
            userId
          )
        );
        setAccountMeta(
          window.DARRIUS_T?.("signedIn") || "SIGNED IN"
        );
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
      setStatus(
        window.DARRIUS_T?.("loginAwaitingCode") || "Sign in with a code sent to your registered email."
      );
      setAccountMeta(
        window.DARRIUS_T?.("guest") || "GUEST"
      );
      updateAccountView(false, null);
      emitAuthChanged(false, null);

      return {
        authenticated: false,
      };
    } catch (error) {
      if (version !== sessionVersion) return {authenticated:false, stale:true};
      console.error(
        "[AccountAuth] session check failed",
        error
      );

      setStatus(window.DARRIUS_T?.('unableCheckSignIn') || 'Unable to check sign-in status. Please retry.');

      return {
        authenticated: false,
      };
    }
  }

  async function signOut() {
    if (authBusy) return;
    authBusy = true;
    ++sessionVersion;
    const button = $("signOutBtn");

    if (button) {
      button.disabled = true;
      button.textContent =
        window.DARRIUS_T?.("signingOut") ||
        "Signing Out...";
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

      setStatus(
        window.DARRIUS_T?.("notSignedIn") || "Not signed in"
      );
      setAccountMeta(
        window.DARRIUS_T?.("guest") || "GUEST"
      );
      updateAccountView(false, null);

      emitAuthChanged(false, null);
    } catch (error) {
      console.error(
        "[AccountAuth] logout failed",
        error
      );

      setStatus(
        window.DARRIUS_T?.("unableSignOut") ||
        "Unable to sign out. Please try again."
      );
    } finally {
      authBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent =
          window.DARRIUS_T?.("signOut") ||
          "Sign Out";
      }
    }
  }

  async function sendVerificationCode() {
    if (sendBusy || authBusy) return;
    const userId = String(
      $("userId")?.value || ""
    ).trim();

    if (!userId) {
      setStatus(
        window.DARRIUS_T?.("enterUserIdFirst") ||
        "Enter your User ID first."
      );
      $("userId")?.focus();
      return;
    }

    sendBusy = true;
    const button = $("sendVerifyBtn");

    if (button) {
      button.disabled = true;
      button.textContent =
        window.DARRIUS_T?.("sending") ||
        "Sending...";
    }

    setStatus(
      window.DARRIUS_T?.("requestingVerificationCode") ||
      "Requesting verification code..."
    );

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
          window.DARRIUS_T?.("verificationCodeSent") ||
          "If this account is eligible, a verification code has been sent to the email on file."
        );

        $("verificationCode")?.focus();
      } else {
        setStatus(
          window.DARRIUS_T?.("unableSendVerificationCode") ||
          "Unable to send a verification code. Please try again later."
        );
      }
    } catch (error) {
      console.error(
        "[AccountAuth] verification request failed",
        error
      );

      setStatus(
        window.DARRIUS_T?.("unableSendVerificationCode") ||
        "Unable to send a verification code. Please try again later."
      );
    } finally {
      sendBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent =
          window.DARRIUS_T?.("sendVerificationCode") ||
          "Send Verification Code";
      }
    }
  }

  async function verifyCode() {
    if (authBusy || sendBusy) return;
    const userId = String(
      $("userId")?.value || ""
    ).trim();

    const code = String(
      $("verificationCode")?.value || ""
    ).replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFF10)).replace(/[\s-]/g, "");

    if (!userId) {
      setStatus(
        window.DARRIUS_T?.("enterUserIdFirst") ||
        "Enter your User ID first."
      );
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      setStatus(
        window.DARRIUS_T?.("enterVerificationCode") ||
        "Enter the 6-digit verification code."
      );
      $("verificationCode")?.focus();
      return;
    }

    authBusy = true;
    ++sessionVersion;
    const button = $("verifyCodeBtn");

    if (button) {
      button.disabled = true;
      button.textContent =
        window.DARRIUS_T?.("verifying") ||
        "Verifying...";
    }

    setStatus(
      window.DARRIUS_T?.("verifying") ||
      "Verifying..."
    );

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
          window.DARRIUS_T?.("verificationFailedCheckCode") ||
          "Verification failed. Check the code and try again."
        );
        return;
      }

      const session = await refreshSession(true);

      if (session.authenticated) {
        showCodeField(false);

        const codeInput = $("verificationCode");

        if (codeInput) {
          codeInput.value = "";
        }
      } else {
        setStatus(
          window.DARRIUS_T?.(
            "verificationSucceededSessionUnconfirmed"
          ) ||
          "Verification succeeded, but the session could not be confirmed."
        );
      }
    } catch (error) {
      console.error(
        "[AccountAuth] verification failed",
        error
      );

      setStatus(
        window.DARRIUS_T?.("verificationFailed") ||
        "Verification failed. Please try again."
      );
    } finally {
      authBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent =
          window.DARRIUS_T?.("verify") ||
          "Verify";
      }
    }
  }

  function attach() {
    const sendButton = $("sendVerifyBtn");
    const verifyButton = $("verifyCodeBtn");
    const codeInput = $("verificationCode");
    const signOutButton = $("signOutBtn");
    if (codeInput) {
      codeInput.setAttribute('maxlength', '16');
      codeInput.setAttribute('autocomplete', 'one-time-code');
      codeInput.setAttribute('inputmode', 'numeric');
      codeInput.setAttribute('autocapitalize', 'off');
    }
    $('userId')?.setAttribute('autocapitalize', 'none');
    $('userId')?.setAttribute('spellcheck', 'false');
    window.addEventListener('pageshow', event => { if(event.persisted) refreshSession(); });
    const accountPageButton = $("accountPageBtn");

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
            event.preventDefault();
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

    if (accountPageButton) {
      accountPageButton.addEventListener(
        "click",
        () => {
          window.location.href = "account.html";
        }
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

    document.addEventListener(
      "darrius:language-changed",
      () => {
        refreshSession();
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