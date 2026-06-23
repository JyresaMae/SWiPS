export class DeploymentMap {
    constructor(containerId) {
        this.wrapper = document.getElementById(containerId);
        if (!this.wrapper) return;

        // Elements
        this.viewport = this.wrapper.querySelector('.map-canvas');
        this.canvas = this.wrapper.querySelector('.map-image-wrapper');
        this.image = this.wrapper.querySelector('.map-blueprint-img');
        this.zoomDisplay = this.wrapper.querySelector('.map-zoom-level');
        this.coordOverlay = this.wrapper.querySelector('.coord-overlay');

        this.popupContainer = null;

        // State
        this.currentTheme = 'dark';
        this.is3D = false;

        this.panX = 0;
        this.panY = 0;
        this.zoom = 1.0;
        this.fitZoom = 1.0;
        this.isDragging = false;
        this.startX = 0;
        this.startY = 0;
        this.initialPanX = 0;
        this.initialPanY = 0;
        this.isPickerMode = false;

        this.tiltRotateX = 28;
        this.tiltRotateY = 0;
        this.orbitStartX = 0;
        this.orbitStartY = 0;
        this.orbitStartRX = 0;
        this.orbitStartRY = 0;

        this.deploymentSites = [
            { id: 'P01', x: 0.498, y: 0.634, status: 'active', name: 'COE Pedestrian Lane', description: 'Pedestrian lane at the College of Engineering crosswalk — MSU-IIT Tibanga Campus', color: '#10b981', glowColor: 'rgba(16, 185, 129, 0.3)', radius: 70, deployed: 'May 2026', cameras: 1, coverage: '371.93 sq.m.', mode: 'Idle / Crossing / Obstruction' },
            { id: 'P02', x: 0.273, y: 0.729, status: 'active', name: 'Canteen Pedestrian Lane', description: 'Pedestrian lane at the Campus Canteen crosswalk — MSU-IIT Tibanga Campus', color: '#f59e0b', glowColor: 'rgba(245, 158, 11, 0.3)', radius: 70, deployed: 'May 2026', cameras: 1, coverage: '297 sq.m.', mode: 'Idle / Crossing / Obstruction' }
        ];

        this.init();
    }

    init() {
        if (!this.image || !this.canvas || !this.viewport) {
            console.warn('[SWiPS Map] Elements missing in container');
            return;
        }

        this.setDarkMode();

        this.wrapper.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (e.currentTarget.dataset.theme === 'dark') this.setDarkMode();
                else this.setLightMode();
            });
        });

        this.setupPanZoom();
        this.setupControls();

        this.canvas.addEventListener('click', (e) => {
            if (!this.isPickerMode && !e.shiftKey) return;
            const rect = this.image.getBoundingClientRect();
            const xVal = ((e.clientX - rect.left) / rect.width).toFixed(3);
            const yVal = ((e.clientY - rect.top) / rect.height).toFixed(3);
            console.log(`📍 picked coords: { x: ${xVal}, y: ${yVal} }`);
            if (this.coordOverlay && this.isPickerMode) {
                this.coordOverlay.textContent = `x: ${xVal}   y: ${yVal}`;
                this.coordOverlay.style.display = 'block';
            }
        });

        this.image.style.width = this.image.naturalWidth + 'px';
        this.image.style.height = 'auto';
        this.image.style.maxWidth = 'none';
        this.image.style.display = 'block';

        if (this.image.complete && this.image.naturalWidth > 0) {
            this.handleImageLoad();
        } else {
            this.image.addEventListener('load', () => this.handleImageLoad());
        }
    }

    handleImageLoad() {
        this.image.style.width = this.image.naturalWidth + 'px';
        this.centerImage();

        const existingMarkers = this.canvas.querySelectorAll('.site-marker');
        existingMarkers.forEach(m => m.remove());
        this.setupMarkers();
    }

    updateTransform(animate = false) {
        if (!this.canvas) return;

        const duration = animate ? '0.5s' : '0s';
        this.canvas.style.transition = `transform ${duration} ease-out`;

        this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.canvas.style.transformOrigin = '0 0';

        if (this.zoomDisplay) {
            this.zoomDisplay.textContent = this.zoom.toFixed(1) + '×';
        }

        const counterScale = 1 / this.zoom;
        this.wrapper.querySelectorAll('.site-marker').forEach(m => {
            m.style.transform = `translate(-50%, -50%) scale(${counterScale})`;
        });
    }

    applyTilt(animate = false) {
        if (!this.viewport) return;
        this.viewport.style.transition = animate
            ? 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
            : 'transform 0.05s ease-out';
        if (this.is3D) {
            this.viewport.style.transform = `rotateX(${this.tiltRotateX}deg) rotateY(${this.tiltRotateY}deg)`;
            this.viewport.style.transformOrigin = '50% 50%';
        } else {
            this.viewport.style.transform = '';
            this.viewport.style.transformOrigin = '';
        }
    }

    centerImage() {
        if (!this.viewport || !this.image) return;
        const canvasW = this.viewport.offsetWidth || this.viewport.clientWidth;
        const canvasH = this.viewport.offsetHeight || this.viewport.clientHeight;

        const imgW = this.image.naturalWidth;
        const imgH = this.image.naturalHeight;

        this.fitZoom = Math.max(canvasW / imgW, canvasH / imgH) * 1.05;
        this.zoom = this.fitZoom;

        this.panX = (canvasW - imgW * this.zoom) / 2;
        this.panY = (canvasH - imgH * this.zoom) / 2;

        this.updateTransform(false);
    }

    setDarkMode() {
        if (!this.wrapper || !this.image) return;
        this.wrapper.classList.remove('light-mode');
        this.wrapper.classList.add('dark-mode');
        this.currentTheme = 'dark';
        this.wrapper.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === 'dark');
        });
        this.wrapper.querySelectorAll('.site-marker svg').forEach(svg => {
            svg.style.color = '#fff';
        });
    }

    setLightMode() {
        if (!this.wrapper || !this.image) return;
        this.wrapper.classList.remove('dark-mode');
        this.wrapper.classList.add('light-mode');
        this.currentTheme = 'light';
        this.wrapper.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === 'light');
        });
        this.wrapper.querySelectorAll('.site-marker svg').forEach(svg => {
            svg.style.color = '#1a2a3a';
        });
    }

    setupPanZoom() {
        this.viewport.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();

            if (this.is3D) {
                this.isDragging = true;
                this.orbitStartX = e.clientX;
                this.orbitStartY = e.clientY;
                this.orbitStartRX = this.tiltRotateX;
                this.orbitStartRY = this.tiltRotateY;
            } else {
                this.isDragging = true;
                this.startX = e.clientX;
                this.startY = e.clientY;
                this.initialPanX = this.panX;
                this.initialPanY = this.panY;
                this.updateTransform(false);
            }
            this.viewport.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;

            if (this.is3D) {
                const dx = e.clientX - this.orbitStartX;
                const dy = e.clientY - this.orbitStartY;
                this.tiltRotateX = Math.max(5, Math.min(80, this.orbitStartRX - dy * 0.35));
                this.tiltRotateY = Math.max(-90, Math.min(90, this.orbitStartRY + dx * 0.35));
                this.applyTilt(false);
            } else {
                const dx = e.clientX - this.startX;
                const dy = e.clientY - this.startY;
                this.panX = this.initialPanX + dx;
                this.panY = this.initialPanY + dy;
                this.updateTransform(false);
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                this.viewport.style.cursor = this.is3D ? 'grab' : (this.isPickerMode ? 'crosshair' : 'grab');
            }
        });

        this.viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = Math.sign(e.deltaY) * -0.15;
            let newZoom = Math.min(Math.max(0.3, this.zoom + delta), 4.0);

            const rect = this.viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            this.panX = mouseX - (mouseX - this.panX) * (newZoom / this.zoom);
            this.panY = mouseY - (mouseY - this.panY) * (newZoom / this.zoom);
            this.zoom = newZoom;
            this.updateTransform(true);
        }, { passive: false });

        this.viewport.addEventListener('dblclick', (e) => {
            const rect = this.viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            let newZoom = Math.min(this.zoom + 0.5, 4.0);
            this.panX = mouseX - (mouseX - this.panX) * (newZoom / this.zoom);
            this.panY = mouseY - (mouseY - this.panY) * (newZoom / this.zoom);
            this.zoom = newZoom;
            this.updateTransform(true);
        });

        let initialTouchDist = 0;

        this.viewport.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this.isDragging = true;
                this.startX = e.touches[0].clientX;
                this.startY = e.touches[0].clientY;
                this.initialPanX = this.panX;
                this.initialPanY = this.panY;
            } else if (e.touches.length === 2) {
                this.isDragging = false;
                initialTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: false });

        this.viewport.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (this.isDragging && e.touches.length === 1) {
                const dx = e.touches[0].clientX - this.startX;
                const dy = e.touches[0].clientY - this.startY;
                this.panX = this.initialPanX + dx;
                this.panY = this.initialPanY + dy;
                this.updateTransform(false);
            } else if (e.touches.length === 2) {
                const currentDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );

                if (initialTouchDist > 0) {
                    const scaleDiff = currentDist / initialTouchDist;
                    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    const rect = this.viewport.getBoundingClientRect();
                    const mouseX = mx - rect.left;
                    const mouseY = my - rect.top;

                    let newZoom = Math.min(Math.max(0.3, this.zoom * scaleDiff), 4.0);
                    this.panX = mouseX - (mouseX - this.panX) * (newZoom / this.zoom);
                    this.panY = mouseY - (mouseY - this.panY) * (newZoom / this.zoom);
                    this.zoom = newZoom;
                    this.updateTransform(false);
                    initialTouchDist = currentDist;
                }
            }
        }, { passive: false });

        this.viewport.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) initialTouchDist = 0;
            if (e.touches.length === 0) this.isDragging = false;
        });
    }

    closePopup() {
        if (this.popupContainer) {
            this.popupContainer.remove();
            this.popupContainer = null;
        }
    }

    createPopup(site, clickX, clickY) {
        this.closePopup();

        this.popupContainer = document.createElement('div');
        this.popupContainer.className = 'marker-popup';


        this.popupContainer.innerHTML = `
          <div class="popup-header">
            <span class="popup-status-dot" style="background: ${site.color}"></span>
            <span class="popup-title">Site ${site.id} — ${site.name}</span>
            <button class="popup-close">&times;</button>
          </div>
          <div class="popup-body">
            <div class="popup-row"><span class="popup-label">Description</span><span class="popup-value">${site.description}</span></div>
            
            <div class="popup-row"><span class="popup-label">Deployed</span><span class="popup-value">${site.deployed}</span></div>
            <div class="popup-row"><span class="popup-label">Cameras</span><span class="popup-value">${site.cameras}× TP-Link VIGI C240</span></div>
            <div class="popup-row"><span class="popup-label">Coverage</span><span class="popup-value">${site.coverage}</span></div>
            <div class="popup-row"><span class="popup-label">Modes</span><span class="popup-value">${site.mode}</span></div>
          </div>
        `;

        this.wrapper.appendChild(this.popupContainer);

        setTimeout(() => {
            const pRect = this.popupContainer.getBoundingClientRect();
            const wRect = this.wrapper.getBoundingClientRect();

            let left = clickX - pRect.width / 2;
            let top = clickY - pRect.height - 30;

            if (top < wRect.top) {
                top = clickY + 30;
            }

            if (left < wRect.left + 10) left = wRect.left + 10;
            if (left + pRect.width > wRect.right - 10) left = wRect.right - pRect.width - 10;

            const relTop = top - wRect.top;
            const relLeft = left - wRect.left;

            this.popupContainer.style.top = relTop + 'px';
            this.popupContainer.style.left = relLeft + 'px';
        }, 0);

        this.popupContainer.querySelector('.popup-close').addEventListener('click', () => this.closePopup());
    }

    setupMarkers() {
        this.deploymentSites.forEach(site => {
            const marker = document.createElement('div');
            marker.className = 'site-marker';
            marker.dataset.siteId = site.id;

            marker.style.position = 'absolute';
            marker.style.left = (site.x * this.image.naturalWidth) + 'px';
            marker.style.top = (site.y * this.image.naturalHeight) + 'px';
            marker.style.transform = 'translate(-50%, -50%)';
            marker.style.zIndex = '20';

            marker.innerHTML = `
              <div class="coverage-circle" style="width: ${site.radius * 2}px; height: ${site.radius * 2}px; border: 1.5px solid ${site.color}40; background: radial-gradient(circle, ${site.color}10 0%, transparent 70%);"></div>
              <div class="marker-body" style="--site-color: ${site.color}; --glow-color: ${site.glowColor}">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: ${this.currentTheme === 'dark' ? '#fff' : '#1a2a3a'}"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
              </div>
              <div class="marker-badge" style="--site-color: ${site.color}">${site.id}</div>
              <div class="pulse-ring pulse-ring-1" style="--site-color: ${site.color}"></div>
              <div class="pulse-ring pulse-ring-2" style="--site-color: ${site.color}"></div>
            `;

            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                this.createPopup(site, e.clientX, e.clientY);
            });

            this.canvas.appendChild(marker);
        });

        this.wrapper.addEventListener('click', () => {
            if (!this.isDragging) this.closePopup();
        });
    }

    setupControls() {
        const btnIn = this.wrapper.querySelector('.zoom-in-btn');
        if (btnIn) {
            btnIn.addEventListener('click', () => {
                const newZoom = Math.min(this.zoom + 0.3, 4.0);
                const cx = this.viewport.offsetWidth / 2;
                const cy = this.viewport.offsetHeight / 2;
                this.panX = cx - (cx - this.panX) * (newZoom / this.zoom);
                this.panY = cy - (cy - this.panY) * (newZoom / this.zoom);
                this.zoom = newZoom;
                this.updateTransform(true);
            });
        }

        const btnOut = this.wrapper.querySelector('.zoom-out-btn');
        if (btnOut) {
            btnOut.addEventListener('click', () => {
                const newZoom = Math.max(this.fitZoom, this.zoom - 0.3);
                const cx = this.viewport.offsetWidth / 2;
                const cy = this.viewport.offsetHeight / 2;
                this.panX = cx - (cx - this.panX) * (newZoom / this.zoom);
                this.panY = cy - (cy - this.panY) * (newZoom / this.zoom);
                this.zoom = newZoom;
                this.updateTransform(true);
            });
        }

        const btnReset = this.wrapper.querySelector('.reset-view-btn');
        if (btnReset) {
            btnReset.addEventListener('click', () => this.centerImage());
        }

        const btnPick = this.wrapper.querySelector('.pick-coords-btn');
        if (btnPick) {
            btnPick.addEventListener('click', () => {
                this.isPickerMode = !this.isPickerMode;
                btnPick.classList.toggle('active', this.isPickerMode);
                if (this.isPickerMode) {
                    this.viewport.style.cursor = 'crosshair';
                    if (this.coordOverlay) {
                        this.coordOverlay.textContent = "PICKER ACTIVE — Click map to get coordinates";
                        this.coordOverlay.style.display = 'block';
                    }
                } else {
                    this.viewport.style.cursor = 'grab';
                    if (this.coordOverlay) this.coordOverlay.style.display = 'none';
                }
            });
        }

        const btnFs = this.wrapper.querySelector('.fullscreen-btn');
        if (btnFs) {
            btnFs.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    this.wrapper.requestFullscreen?.();
                } else {
                    document.exitFullscreen?.();
                }
            });

            const onFsChange = () => {
                setTimeout(() => this.centerImage(), 100);
            };
            document.addEventListener('fullscreenchange', onFsChange);
            document.addEventListener('webkitfullscreenchange', onFsChange);
        }

        const btnTilt = this.wrapper.querySelector('.tilt-toggle-btn');
        if (btnTilt) {
            btnTilt.addEventListener('click', () => {
                this.is3D = !this.is3D;
                btnTilt.classList.toggle('active', this.is3D);
                this.wrapper.classList.toggle('tilt-3d', this.is3D);

                if (this.is3D) {
                    this.tiltRotateX = 28;
                    this.tiltRotateY = 0;
                }

                this.applyTilt(true);
            });
        }
    }
}
