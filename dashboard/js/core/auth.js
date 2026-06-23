import { state } from './state.js';
import { animateValue } from '../utils/helpers.js';

const AUTH_CONFIG = {
    email: 'admin@swips.edu.ph',
    password: 'swips2025',
    sessionTimeout: 30 * 60 * 1000 // 30 minutes
};

const elements = {
    loginScreen: document.getElementById('login-screen'),
    loginForm: document.getElementById('loginForm'),
    emailInput: document.getElementById('email'),
    passwordInput: document.getElementById('password'),
    togglePassword: document.getElementById('togglePassword'),
    loginBtn: document.getElementById('loginBtn'),
    loginError: document.getElementById('loginError'),
    logoutBtn: document.getElementById('logoutBtn'),
    appLayout: document.querySelector('.app-layout'),
    // Elements for final polish animation
    liveIndicator: document.getElementById('liveIndicator'),
    pedestriansNow: document.getElementById('pedestriansNow'),
    latencyValue: document.getElementById('latencyValue'),
    activeAlerts: document.getElementById('activeAlerts'),
};

export function initAuth() {
    // Check session
    const session = sessionStorage.getItem('swips_session');
    if (session) {
        const { timestamp } = JSON.parse(session);
        if (Date.now() - timestamp < AUTH_CONFIG.sessionTimeout) {
            loginSuccess(true); // Skip animation if already logged in
        } else {
            logout(); // Session expired
        }
    }

    // Event Listeners
    if (elements.loginForm) {
        elements.loginForm.addEventListener('submit', handleLogin);
    }

    if (elements.togglePassword) {
        elements.togglePassword.addEventListener('click', () => {
            const type = elements.passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            elements.passwordInput.setAttribute('type', type);
        });
    }

    if (elements.logoutBtn) {
        elements.logoutBtn.addEventListener('click', logout);
    }

    // Activity Tracker
    document.addEventListener('mousemove', resetActivityTimer);
    document.addEventListener('keydown', resetActivityTimer);
    setInterval(checkSessionTimeout, 60000); // Check every minute
}

function handleLogin(e) {
    e.preventDefault();

    const email = elements.emailInput.value;
    const password = elements.passwordInput.value;

    elements.loginBtn.classList.add('loading');
    elements.loginBtn.disabled = true;
    elements.loginError.style.display = 'none';

    // Simulate network delay
    setTimeout(() => {
        if (email === AUTH_CONFIG.email && password === AUTH_CONFIG.password) {
            loginSuccess(false);
        } else {
            showLoginError();
        }
        elements.loginBtn.classList.remove('loading');
        elements.loginBtn.disabled = false;
    }, 800);
}

function showLoginError() {
    elements.loginError.style.display = 'flex';
    elements.passwordInput.value = '';
    elements.passwordInput.focus();
}

function loginSuccess(skipAnimation) {
    state.isAuthenticated = true;
    state.lastActivity = Date.now();
    sessionStorage.setItem('swips_session', JSON.stringify({ timestamp: Date.now() }));

    if (skipAnimation) {
        elements.loginScreen.style.display = 'none';
        elements.appLayout.style.display = 'flex';
        elements.appLayout.style.opacity = '1';

        // Jump to final state
        elements.appLayout.classList.add('animate-entry');

    } else {
        // 1. FADE OUT LOGIN (200ms)
        elements.loginScreen.classList.add('hidden');

        setTimeout(() => {
            elements.loginScreen.style.display = 'none';
            elements.appLayout.style.display = 'flex';
            elements.appLayout.style.opacity = '1';

            // 2. TRIGGER SINGLE SLIDE-IN (Staggered via CSS)
            requestAnimationFrame(() => {
                elements.appLayout.classList.add('animate-entry');

                // 3. FINAL POLISH (Trigger after first card arrives ~500ms)
                setTimeout(() => {
                    triggerFinalPolish();
                }, 500);
            });

        }, 200); // Wait for fast login fade out
    }
}

function triggerFinalPolish() {
    if (elements.liveIndicator) elements.liveIndicator.classList.add('pulse-active');

    // Count up numbers
    animateValue(elements.pedestriansNow, 0, state.pedestriansNow, 2000); // 2s duration
    animateValue(elements.latencyValue, 0, state.latencyMs, 2000);
    animateValue(elements.activeAlerts, 0, state.activeAlerts, 2000);
}

export function logout() {
    state.isAuthenticated = false;
    sessionStorage.removeItem('swips_session');

    // Reset Animations
    elements.appLayout.classList.remove('animate-entry');
    if (elements.liveIndicator) elements.liveIndicator.classList.remove('pulse-active');

    // Fade out dashboard
    elements.appLayout.style.opacity = '0';

    setTimeout(() => {
        elements.appLayout.style.display = 'none';

        // Show login
        elements.loginScreen.style.display = 'flex';
        // Small delay to allow display:flex to apply before removing hidden class for transition
        requestAnimationFrame(() => {
            elements.loginScreen.classList.remove('hidden');
        });

        // Reset form
        elements.emailInput.value = '';
        elements.passwordInput.value = '';
        elements.loginError.style.display = 'none';
    }, 500);
}

function resetActivityTimer() {
    state.lastActivity = Date.now();
    // Update session timestamp to keep it alive
    if (state.isAuthenticated) {
        sessionStorage.setItem('swips_session', JSON.stringify({ timestamp: Date.now() }));
    }
}

function checkSessionTimeout() {
    if (state.isAuthenticated) {
        if (Date.now() - state.lastActivity > AUTH_CONFIG.sessionTimeout) {
            logout();
        }
    }
}
