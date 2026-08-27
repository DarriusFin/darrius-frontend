// js/i18n.js
(() => {
  'use strict';

  const STORAGE_KEY = 'darrius_language';

  // Keep the architecture ready for the six UN official languages.
  // Only English and Chinese are enabled for now.
  const LANGUAGES = {
    en: {
      label: 'English',
      dir: 'ltr',
      enabled: true,
    },

    'zh-CN': {
      label: '中文',
      dir: 'ltr',
      enabled: true,
    },

    fr: {
      label: 'Français',
      dir: 'ltr',
      enabled: false,
    },

    es: {
      label: 'Español',
      dir: 'ltr',
      enabled: false,
    },

    ru: {
      label: 'Русский',
      dir: 'ltr',
      enabled: false,
    },

    ar: {
      label: 'العربية',
      dir: 'rtl',
      enabled: false,
    },
  };

  const translations = {
    en: {
      userManual: 'User Manual',
      dashboardReady: 'Dashboard Ready',
      announcementNew: 'NEW',
      announcementTitle: 'Rank Engine · Top 10 is now available',
      announcementDesc:
        'AI-assisted stock ranking is now available for eligible accounts.',
      riskCopilot: 'Risk Copilot',
      rankEngine: 'Rank Engine',
      openRankEngine: 'Open Rank Engine',
      rankingAccess:
        'Ranking access depends on your current subscription.',
      chartControls: 'Chart Controls',
      loadSymbol: 'Load Symbol',
      account: 'Account',
      subscription: 'Subscription',
      signedInAs: 'Signed in as',
      accountSubscription: 'Account & Subscription',
      userId: 'User ID',
      required: 'Required',
      email: 'Email',
      plan: 'Plan',
      subscribe: 'Subscribe',
      managePlan: 'Manage Plan',
      affiliateProgram: 'Affiliate Program',
      openAffiliateProgram: 'Open Affiliate Program',
      marketPulse: 'Market Pulse',
      sentiment: 'Sentiment',
      bullish: 'Bullish',
      bearish: 'Bearish',
      neutral: 'Neutral',
      netInflow: 'Net Inflow',
      derivedFromMainChart: 'Derived from the main chart only.',
      explore: 'Explore',
      share: 'Share',
      export: 'Export',
      marketSnapshotLoaded: 'Market snapshot loaded',
      signOut: 'Sign Out',
      sendVerificationCode: 'Send Verification Code',
      verify: 'Verify',
      guest: 'GUEST',
      signedIn: 'SIGNED IN',
      statusUnknown: 'STATUS: UNKNOWN',
      signInRequired: 'SIGN IN REQUIRED',
      updatedStatus: 'Updated: {value}',
      notSignedIn: 'Not signed in',
      signedInStatus: 'Signed in: {user}',
      unableCheckSignIn: 'Unable to check sign-in status',
      loadingPlans: 'Loading plans...',
      activePlan: 'Active Plan: {plan}',
      planWeekly: 'Weekly',
      planMonthly: 'Monthly',
      planQuarterly: 'Quarterly',
      planYearly: 'Yearly',
      activeSubscription: 'Active Subscription',
      trialAccess: 'Trial Access',
      subscriptionPending: 'Subscription Pending',
      paymentIssueGrace:
        'Payment Issue — Access Temporarily Available',
      subscriptionExpired: 'Subscription Expired',
      noActiveSubscription: 'No Active Subscription',
      endsOn: 'Ends {date}',
      signInToCheckSubscription:
        'Sign in to check your subscription',
      unableSignOut: 'Unable to sign out. Please try again.',
      enterUserIdFirst: 'Enter your User ID first.',
      requestingVerificationCode:
        'Requesting verification code...',
      verificationCodeSent:
        'If this account is eligible, a verification code has been sent to the email on file.',
      unableSendVerificationCode:
        'Unable to send a verification code. Please try again later.',
      enterVerificationCode:
        'Enter the 6-digit verification code.',
      verifying: 'Verifying...',
      verificationFailedCheckCode:
        'Verification failed. Check the code and try again.',
      verificationSucceededSessionUnconfirmed:
        'Verification succeeded, but the session could not be confirmed.',
      verificationFailed:
        'Verification failed. Please try again.',
      riskEntryLabel: 'Entry',
      riskStopLabel: 'Stop',
      riskTargetsLabel: 'Targets',
      riskConfidenceLabel: 'Confidence',
      riskBacktestWinRateLabel: 'Backtest Win Rate',
      riskLevelsDisclaimer:
        'Levels are model-derived estimates based on the active chart context.',
      rankEngineDescription:
        'AI-assisted ranking highlights stocks with the strongest combined market pulse and model signals.',
      symbol: 'Symbol',
      timeframe: 'Timeframe',
      dataSource: 'Data Source',
      licensedData: 'Licensed Data',
      licensedMarketDataProvided:
        'Licensed market data provided via Twelve Data Pro.',
      symbolExample: 'e.g. TSLA / AAPL',
      timeframe5m: '5 Minutes',
      timeframe15m: '15 Minutes',
      timeframe30m: '30 Minutes',
      timeframe1h: '1 Hour',
      timeframe4h: '4 Hours',
      timeframe1d: '1 Day',
      timeframe1w: '1 Week',
      timeframe1M: '1 Month',
      emaAuxManagedInternally:
        'EMA and AUX parameters are managed internally.',
      verificationCode: 'Verification Code',
      sixDigits: '6 digits',
      statusLabel: 'Status:',
      unknown: 'Unknown',
      accountStatusValue: 'STATUS: {value}',
      completeSubscriptionFirst: 'Complete subscription first',
      connected: 'Connected',
      disclaimer: 'Disclaimer',
      disclaimerInformational:
        'For informational purposes only. Nothing on this platform constitutes investment advice, a recommendation, or an offer or solicitation to buy or sell any security or financial instrument.',
      disclaimerRisk:
        'Signals and analytics are algorithmic estimates and may be inaccurate, delayed, or incomplete. Past performance is not indicative of future results. You are solely responsible for your investment decisions and risk.',
      supportLabel: 'Support:',
      affiliateCommissionTerms:
        'Commission terms are available in the dashboard and affiliate agreement.',
      copyChartLink: 'Copy chart link',
      exportChartPng: 'Export chart as PNG',
      closeUpdateAnnouncement: 'Close update announcement',
      dashboardTools: 'Dashboard tools',
      aiDecisionSystem: 'AI Decision System',
      inflectionHunter: 'Inflection Hunter',
      loading: 'Loading…',
      pageTitle:
        'DarriusAI · Inflection Hunter | AI Decision System',
      darriusMutant: 'Darrius Mutant',
      loadingOption: 'Loading...',
      chartLabel: 'Chart:',
      chartingByTradingView: 'Charting by TradingView',
      terms: 'Terms',
      privacy: 'Privacy',
      support: 'Support',
      termsComingSoon: 'Terms page coming soon',
      privacyComingSoon: 'Privacy Policy page coming soon',
      signingOut: 'Signing Out...',
      sending: 'Sending...',
      sendVerificationCode: 'Send Verification Code',
      shareLinkCopied: 'Share link copied:',
      copyFailedManual:
        'Copy failed. Please copy the link manually:',
      chartCoreMissing: 'ChartCore missing (js not loaded)',
      enterUserIdBeforeRank:
        'Enter your User ID before opening Rank Engine.',
      accountAccessLoading:
        'Account access status is still loading. Please try again shortly.',
      rankEngineLocked:
        'Rank Engine is not unlocked for this account. Please activate a subscription or trial first.',
      chartInitFailed: 'Chart init failed',
      dashboardReady: 'Dashboard Ready',
      loadingMarketSnapshot:
        'Loading market snapshot...',
      snapshotFailed:
        'Snapshot failed · {message}',
      unableExportChart:
        'Unable to export the chart. Please try again.',
      lockedSubscribeToUnlock:
        'Locked: subscribe to unlock Symbol/Timeframe.',
      userIdRequiredToCreateAccount:
        'User ID is required to create your account.',
      emailRequiredToCreateAccount:
        'Email is required to create your account.',
      priceIdNotFound:
        'Price ID was not found. Please refresh the page or contact support.',
      subscriptionNetworkError:
        'Subscription failed due to a network or server error.',
      errorLabel:
        'Error:',
      networkApiError: 'Network/API error',
      signInBeforeManagingSubscription:
        'Please sign in before managing your subscription.',
      noActiveSubscriptionFound:
        'No active subscription was found for this account.',
      billingManagementUnavailable:
        'Billing management is not available for this account yet.',
      subscriptionManagementUnavailable:
        'Subscription management is temporarily unavailable. Please try again later.',
      bucketActive: 'ACTIVE',
      bucketTrial: 'TRIAL',
      bucketPending: 'PENDING',
      bucketGrace: 'GRACE',
      bucketExpired: 'EXPIRED',
      accessStatus: 'Access: {status}',
      bucketDemo: 'DEMO',
      plansAvailable:
        '{count} Plans Available',
      plansAvailableGeneric: 'Plans Available',
      apiDegraded: 'API Degraded',
      creatingCheckout: 'Creating checkout…',
      redirectingToStripe: 'Redirecting to Stripe…',
      dataDelayed:
        'DELAYED {minutes}m',
      dataRealTime:
        'REAL-TIME',
      referralDetected: 'Referral detected: {code}',
      referralAppliedCheckout: 'Will be applied at checkout',
      apiOk: 'API OK',
      checking: 'CHECKING...',
      unableLoadSubscriptionStatus: 'Unable to load subscription status',
      yesLabel: 'YES',
      noLabel: 'NO',
      signInAgainBillingPortal: 'Please sign in again, then retry Billing Portal.',
      billingPortalError: 'Billing portal error: {detail}',
      checkoutNotReady:
        'Checkout not ready: backend did not return {url}. Please check /billing/create-checkout-session or /billing/checkout response.',
      subscriptionStatusActive: 'Active',
      subscriptionStatusTrialing: 'Trialing',
      subscriptionStatusPastDue: 'Past Due',
      subscriptionStatusCanceled: 'Canceled',
      subscriptionStatusUnpaid: 'Unpaid',
      subscriptionStatusIncomplete: 'Incomplete',
      subscriptionStatusIncompleteExpired: 'Incomplete — Expired',
      subscriptionStatusPaused: 'Paused',
      top10: 'TOP 10',
      marketMeta: 'MARKET',
      partners: 'PARTNERS',
      allRightsReserved: 'All Rights Reserved.',
      unableToLoad: 'Unable to load',
      trialPaymentNotice:
        'Trial access requires a valid payment method. Access is disabled automatically if payment is not completed when the trial ends.',
    },

    'zh-CN': {
      userManual: '用户手册',
      dashboardReady: '控制面板已就绪',
      announcementNew: '新功能',
      announcementTitle: '排名引擎 · Top 10 现已上线',
      announcementDesc:
        'AI 辅助股票排名现已向符合条件的账户开放。',
      riskCopilot: '风险辅助',
      rankEngine: '排名引擎',
      openRankEngine: '打开排名引擎',
      rankingAccess:
        '排名功能访问权限取决于您当前的订阅状态。',
      chartControls: '图表控制',
      loadSymbol: '加载股票',
      account: '账户',
      subscription: '订阅',
      signedInAs: '当前登录',
      accountSubscription: '账户与订阅',
      userId: '用户 ID',
      required: '必填',
      email: '邮箱',
      plan: '订阅方案',
      subscribe: '订阅',
      managePlan: '管理订阅',
      affiliateProgram: '推广合作计划',
      openAffiliateProgram: '打开推广合作计划',
      marketPulse: '市场情绪',
      sentiment: '市场情绪',
      bullish: '看多',
      bearish: '看空',
      neutral: '观望',
      netInflow: '资金净流入',
      derivedFromMainChart: '仅根据主图表数据计算。',
      explore: '查看',
      share: '分享',
      export: '导出',
      marketSnapshotLoaded: '市场快照已加载',
      signOut: '退出登录',
      sendVerificationCode: '发送验证码',
      verify: '验证',
      guest: '访客',
      signedIn: '已登录',
      statusUnknown: '状态：未知',
      signInRequired: '需要登录',
      updatedStatus: '更新时间：{value}',
      notSignedIn: '未登录',
      signedInStatus: '已登录：{user}',
      unableCheckSignIn: '无法检查登录状态',
      loadingPlans: '正在加载订阅方案...',
      activePlan: '当前订阅方案：{plan}',
      planWeekly: '每周',
      planMonthly: '每月',
      planQuarterly: '每季度',
      planYearly: '每年',
      activeSubscription: '有效订阅',
      trialAccess: '试用权限',
      subscriptionPending: '订阅处理中',
      paymentIssueGrace:
        '支付异常 — 当前仍可暂时访问',
      subscriptionExpired: '订阅已到期',
      noActiveSubscription: '暂无有效订阅',
      endsOn: '到期：{date}',
      signInToCheckSubscription:
        '请登录以查看订阅状态',
      unableSignOut: '无法退出登录，请重试。',
      enterUserIdFirst: '请先输入用户 ID。',
      requestingVerificationCode:
        '正在请求验证码...',
      verificationCodeSent:
        '如果该账户符合条件，验证码已发送至账户绑定邮箱。',
      unableSendVerificationCode:
        '无法发送验证码，请稍后重试。',
      enterVerificationCode:
        '请输入 6 位验证码。',
      verifying: '正在验证...',
      verificationFailedCheckCode:
        '验证失败，请检查验证码后重试。',
      verificationSucceededSessionUnconfirmed:
        '验证成功，但无法确认登录会话。',
      verificationFailed:
        '验证失败，请重试。',
      riskEntryLabel: '参考入场水平',
      riskStopLabel: '参考止损水平',
      riskTargetsLabel: '参考目标水平',
      riskConfidenceLabel: '模型置信度',
      riskBacktestWinRateLabel: '历史模型回测参考',
      riskLevelsDisclaimer:
        '各水平为模型根据当前图表环境生成的估计值。',
      rankEngineDescription:
        'AI 辅助排名会突出显示市场情绪与模型信号综合表现最强的股票。',
      symbol: '股票代码',
      timeframe: '时间周期',
      dataSource: '数据源',
      licensedData: '授权数据',
      licensedMarketDataProvided:
        '授权市场数据由 Twelve Data Pro 提供。',
      symbolExample: '例如 TSLA / AAPL',
      timeframe5m: '5 分钟',
      timeframe15m: '15 分钟',
      timeframe30m: '30 分钟',
      timeframe1h: '1 小时',
      timeframe4h: '4 小时',
      timeframe1d: '1 天',
      timeframe1w: '1 周',
      timeframe1M: '1 个月',
      emaAuxManagedInternally:
        'EMA 和 AUX 参数由系统内部管理。',
      verificationCode: '验证码',
      sixDigits: '6 位数字',
      statusLabel: '状态：',
      unknown: '未知',
      accountStatusValue: '状态：{value}',
      completeSubscriptionFirst: '请先完成订阅',
      connected: '已连接',
      disclaimer: '免责声明',
      disclaimerInformational:
        '仅供信息参考。本平台任何内容均不构成投资建议、推荐，亦不构成买卖任何证券或金融工具的要约或招揽。',
      disclaimerRisk:
        '信号与分析结果均为算法估算，可能存在不准确、延迟或不完整的情况。历史表现不代表未来结果。您需自行对投资决策及相关风险负责。',
      supportLabel: '客服：',
      affiliateCommissionTerms:
        '佣金条款可在控制面板和推广合作协议中查看。',
      copyChartLink: '复制图表链接',
      exportChartPng: '将图表导出为 PNG',
      closeUpdateAnnouncement: '关闭更新公告',
      dashboardTools: '控制面板工具',
      aiDecisionSystem: 'AI 决策系统',
      inflectionHunter: '拐点猎手',
      loading: '正在加载…',
      pageTitle:
        'DarriusAI · 拐点猎手 | AI 决策系统',
      darriusMutant: '资金动能',
      loadingOption: '正在加载...',
      chartLabel: '图表：',
      chartingByTradingView: '由 TradingView 提供图表',
      terms: '服务条款',
      privacy: '隐私政策',
      support: '客服',
      termsComingSoon: '服务条款页面即将上线',
      privacyComingSoon: '隐私政策页面即将上线',
      signingOut: '正在退出登录...',
      sending: '正在发送...',
      sendVerificationCode: '发送验证码',
      shareLinkCopied: '分享链接已复制：',
      copyFailedManual:
        '复制失败，请手动复制链接：',
      chartCoreMissing: 'ChartCore 未加载',
      enterUserIdBeforeRank:
        '请先输入用户 ID，再打开排名引擎。',
      accountAccessLoading:
        '账户访问状态仍在加载中，请稍后重试。',
      rankEngineLocked:
        '当前账户尚未解锁排名引擎，请先激活订阅或试用。',
      chartInitFailed: '图表初始化失败',
      dashboardReady: '控制面板已就绪',
      loadingMarketSnapshot:
        '正在加载市场快照...',
      snapshotFailed:
        '市场快照加载失败 · {message}',
      unableExportChart:
        '无法导出图表，请重试。',
      lockedSubscribeToUnlock:
        '已锁定：订阅后可解锁股票代码与时间周期。',
      userIdRequiredToCreateAccount:
        '创建账户需要填写用户 ID。',
      emailRequiredToCreateAccount:
        '创建账户需要填写邮箱。',
      priceIdNotFound:
        '未找到价格 ID，请刷新页面或联系客服。',
      subscriptionNetworkError:
        '订阅失败，可能是网络或服务器错误。',
      errorLabel:
        '错误：',
      networkApiError: '网络/API 错误',
      signInBeforeManagingSubscription:
        '请先登录，再管理您的订阅。',
      noActiveSubscriptionFound:
        '未找到该账户的有效订阅。',
      billingManagementUnavailable:
        '该账户暂时无法使用账单管理功能。',
      subscriptionManagementUnavailable:
        '订阅管理功能暂时不可用，请稍后重试。',
      bucketActive: '有效',
      bucketTrial: '试用',
      bucketPending: '处理中',
      bucketGrace: '宽限期',
      bucketExpired: '已到期',
      accessStatus: '访问状态：{status}',
      bucketDemo: '演示',
      plansAvailable:
        '{count} 个订阅方案可用',
      plansAvailableGeneric: '订阅方案可用',
      apiDegraded: 'API 服务降级',
      creatingCheckout: '正在创建结账会话…',
      redirectingToStripe: '正在跳转至 Stripe…',
      dataDelayed:
        '延迟 {minutes} 分钟',
      dataRealTime:
        '实时',
      referralDetected: '已检测到推荐码：{code}',
      referralAppliedCheckout: '将在结账时自动应用',
      apiOk: 'API 正常',
      checking: '检查中...',
      unableLoadSubscriptionStatus: '无法加载订阅状态',
      yesLabel: '是',
      noLabel: '否',
      signInAgainBillingPortal: '请重新登录，然后再次尝试打开账单管理。',
      billingPortalError: '账单管理发生错误：{detail}',
      checkoutNotReady:
        '结账功能尚未就绪：后端未返回 {url}。请检查 /billing/create-checkout-session 或 /billing/checkout 的响应。',
      subscriptionStatusActive: '有效',
      subscriptionStatusTrialing: '试用中',
      subscriptionStatusPastDue: '付款逾期',
      subscriptionStatusCanceled: '已取消',
      subscriptionStatusUnpaid: '未付款',
      subscriptionStatusIncomplete: '未完成',
      subscriptionStatusIncompleteExpired: '未完成并已过期',
      subscriptionStatusPaused: '已暂停',
      top10: '前 10 名',
      marketMeta: '市场',
      partners: '合作伙伴',
      allRightsReserved: '保留所有权利。',
      unableToLoad: '无法加载',
      trialPaymentNotice:
        '试用访问需要绑定有效的付款方式。如果试用结束时未完成付款，访问权限将自动停用。',
    },
  };

  function t(key) {
    const lang =
      window.__DARRIUS_LANGUAGE__ ||
      'en';

    const dictionary =
      translations[lang] ||
      translations.en;

    return (
      dictionary[key] ??
      translations.en[key] ??
      key
    );
  }

window.DARRIUS_T = t;

  const $ = (id) =>
    document.getElementById(id);

  function getInitialLanguage() {
    try {
      const saved =
        localStorage.getItem(STORAGE_KEY);

      if (
        saved &&
        LANGUAGES[saved] &&
        LANGUAGES[saved].enabled
      ) {
        return saved;
      }
    } catch (_) {}

    return 'en';
  }

  function translatePage(lang) {
    const dictionary =
      translations[lang] ||
      translations.en;

    const fallback =
      translations.en;

    document
      .querySelectorAll('[data-i18n]')
      .forEach((el) => {
        const key =
          el.getAttribute('data-i18n');

        if (!key) return;

        const text =
          dictionary[key] ??
          fallback[key];

        if (text !== undefined) {
          el.textContent = text;
        }
      });

    document
      .querySelectorAll('[data-i18n-title]')
      .forEach((el) => {
        const key =
          el.getAttribute('data-i18n-title');

        if (!key) return;

        const text =
          dictionary[key] ??
          fallback[key];

        if (text !== undefined) {
          el.setAttribute('title', text);
        }
      });

    document
      .querySelectorAll('[data-i18n-aria-label]')
      .forEach((el) => {
        const key =
          el.getAttribute('data-i18n-aria-label');

        if (!key) return;

        const text =
          dictionary[key] ??
          fallback[key];

        if (text !== undefined) {
          el.setAttribute('aria-label', text);
        }
      });
  }

  function updateLanguageUI(lang) {
    const config =
      LANGUAGES[lang] ||
      LANGUAGES.en;

    const label =
      $('currentLanguageLabel');

    if (label) {
      label.textContent = config.label;
    }

    document
      .querySelectorAll(
        '.languageOption[data-lang]'
      )
      .forEach((button) => {
        button.classList.toggle(
          'active',
          button.dataset.lang === lang
        );
      });
  }

  function closeMenu() {
    const dropdown =
      $('languageDropdown');

    const trigger =
      $('languageTrigger');

    if (dropdown) {
      dropdown.hidden = true;
    }

    if (trigger) {
      trigger.setAttribute(
        'aria-expanded',
        'false'
      );
    }
  }

  function openMenu() {
    const dropdown =
      $('languageDropdown');

    const trigger =
      $('languageTrigger');

    if (dropdown) {
      dropdown.hidden = false;
    }

    if (trigger) {
      trigger.setAttribute(
        'aria-expanded',
        'true'
      );
    }
  }

  function toggleMenu() {
    const dropdown =
      $('languageDropdown');

    if (!dropdown) return;

    if (dropdown.hidden) {
      openMenu();
    } else {
      closeMenu();
    }
  }

  function setLanguage(lang) {
    const config =
      LANGUAGES[lang];

    if (
      !config ||
      config.enabled !== true
    ) {
      lang = 'en';
    }

    const activeConfig =
      LANGUAGES[lang];

    document.documentElement.lang =
      lang;

    document.documentElement.dir =
      activeConfig.dir;

    try {
      localStorage.setItem(
        STORAGE_KEY,
        lang
      );
    } catch (_) {}

    window.__DARRIUS_LANGUAGE__ =
      lang;

    translatePage(lang);
    updateLanguageUI(lang);
    closeMenu();

    document.dispatchEvent(
      new CustomEvent(
        'darrius:language-changed',
        {
          detail: {
            language: lang,
            dir: activeConfig.dir,
          },
        }
      )
    );
  }

  function init() {
    const trigger =
      $('languageTrigger');

    const menu =
      $('languageMenu');

    if (!trigger || !menu) {
      return;
    }

    trigger.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        toggleMenu();
      }
    );

    document
      .querySelectorAll(
        '.languageOption[data-lang]'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopPropagation();

            setLanguage(
              button.dataset.lang
            );
          }
        );
      });

    document.addEventListener(
      'click',
      (event) => {
        if (
          !menu.contains(event.target)
        ) {
          closeMenu();
        }
      }
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          closeMenu();
        }
      }
    );

    setLanguage(
      getInitialLanguage()
    );
  }

  if (
    document.readyState === 'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      init
    );
  } else {
    init();
  }
})();