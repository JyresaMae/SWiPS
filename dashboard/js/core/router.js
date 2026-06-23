
export function initRouter() {
    const sidebarItems = document.querySelectorAll('.sidebar-item');

    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            // 1. Update Sidebar Active State
            sidebarItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            // 2. Get Target View ID
            const sectionName = item.dataset.section;
            const targetViewId = `view-${sectionName}`;
            const targetView = document.getElementById(targetViewId);

            // 3. Switch Views
            if (targetView) {
                // Hide all views
                document.querySelectorAll('.view-section').forEach(view => {
                    view.classList.remove('active');
                });
                // Show target view
                targetView.classList.add('active');

                // Trigger Animations / Init based on View
                if (sectionName === 'about') {
                    import('../sections/about.js')
                        .then(module => module.playAboutAnimation())
                        .catch(err => console.error('Failed to load About section:', err));
                } else if (sectionName === 'map') {
                    // Slight delay to allow display:flex to render so dimensions are correct
                    setTimeout(() => {
                        import('../sections/map.js')
                            .then(module => {
                                if (!window.fullMapInstance) {
                                    window.fullMapInstance = new module.DeploymentMap('deployMapWrapper');
                                } else {
                                    window.fullMapInstance.centerImage();
                                }
                            })
                            .catch(err => console.error('Failed to load Map section:', err));
                    }, 50);
                } else if (sectionName === 'analytics') {
                    import('../sections/analytics.js')
                        .then(module => module.initAnalytics())
                        .catch(err => console.error('Failed to load Analytics section:', err));
                } else if (sectionName === 'alerts') {
                    import('../sections/alerts.js')
                        .then(module => module.initAlerts())
                        .catch(err => console.error('Failed to load Alerts section:', err));
                } else if (sectionName === 'performance') {
                    setTimeout(() => {
                        import('../sections/performance.js')
                            .then(module => module.initPerformance())
                            .catch(err => console.error('Failed to load Performance section:', err));
                    }, 100);
                } else if (sectionName === 'settings') {
                    import('../sections/settings.js')
                        .then(module => module.initSettings())
                        .catch(err => console.error('Failed to load Settings section:', err));
                } else if (sectionName === 'compliance') {
                    import('../sections/compliance.js')
                        .then(module => module.initCompliance())
                        .catch(err => console.error('Failed to load Compliance section:', err));
                }
            } else {
                console.error('Target view not found:', targetViewId);
            }
        });
    });
}
