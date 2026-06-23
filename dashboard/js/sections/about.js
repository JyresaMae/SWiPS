/**
 * About SWiPS — Section Module
 * Handles scroll-based reveal animations for all content blocks.
 */

let revealObserver = null;

/**
 * Set up IntersectionObserver-based reveal animations for .abt-reveal elements.
 */
function setupRevealAnimations() {
    const revealItems = document.querySelectorAll('.abt-reveal');

    // If observer already exists, disconnect it first
    if (revealObserver) {
        revealObserver.disconnect();
    }

    revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                gsap.to(entry.target, {
                    opacity: 1,
                    y: 0,
                    duration: 0.7,
                    delay: index * 0.08,
                    ease: "power2.out"
                });
                revealObserver.unobserve(entry.target);
            }
        });
    }, {
        root: document.querySelector('.about-body'),
        threshold: 0.1,
        rootMargin: '0px 0px -30px 0px'
    });

    revealItems.forEach(item => {
        // Reset to hidden state
        gsap.set(item, { opacity: 0, y: 30 });
        revealObserver.observe(item);
    });
}

/**
 * Initialize the About section.
 * Called when the user navigates to the About SWiPS page.
 */
export function initAbout() {
    // Set up scroll-based reveal animations for content blocks
    // Short delay to ensure the view is visible before observing
    setTimeout(() => {
        setupRevealAnimations();
    }, 100);
}
