/* ==========================================================================
   THE COLLECTIVE — Hero Image Trail
   Interactive cursor-following gallery effect.

   Architecture:
     1. ImagePool   — Reusable pool of DOM nodes (prevents GC thrashing)
     2. ImageLoader — Async preloader & URL generator for hundreds of images
     3. ImageTrail  — Orchestrates spawning, animation, and cleanup
     4. init()      — Entry point, wires everything together
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   IMAGE SOURCE GENERATOR
   Generates unique, high-quality image URLs from Lorem Picsum.
   Supports hundreds of images by cycling through curated photo IDs.
   -------------------------------------------------------------------------- */
const ImageLoader = (() => {
    /**
     * Define the path to your images folder and total number of images.
     * Name your images: 1.jpg, 2.jpg, 3.jpg, etc., and put them in the images folder.
     */
    const IMAGE_FOLDER = './images';
    const TOTAL_IMAGES = 5; // Change this to match your total number of images
    const IMAGE_EXTENSION = 'jpg'; // e.g. 'jpg', 'png', 'webp'

    // Create an array of numbers [1, 2, 3, ... TOTAL_IMAGES]
    const imageIndices = Array.from({ length: TOTAL_IMAGES }, (_, i) => i + 1);

    /** Aspect ratios to add visual variety */
    const ASPECT_RATIOS = [
        { w: 300, h: 400 },  // Portrait
        { w: 300, h: 380 },  // Tall portrait
        { w: 280, h: 350 },  // Slim portrait
        { w: 340, h: 260 },  // Landscape
        { w: 300, h: 300 },  // Square
        { w: 320, h: 400 },  // Wide portrait
        { w: 260, h: 360 },  // Narrow portrait
    ];

    let currentIndex = 0;
    const preloadedSet = new Set();

    /**
     * Build the URL for your local image.
     */
    function buildUrl(num) {
        return `${IMAGE_FOLDER}/${num}.${IMAGE_EXTENSION}`;
    }

    /**
     * Shuffle an array in-place (Fisher-Yates).
     */
    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /* Shuffle indices once at startup so the trail feels random each session */
    shuffle(imageIndices);

    /**
     * Get the next image source (cycles through local images).
     * @returns {{ url: string, width: number, height: number }}
     */
    function getNext() {
        const num = imageIndices[currentIndex % imageIndices.length];
        const aspect = ASPECT_RATIOS[currentIndex % ASPECT_RATIOS.length];
        currentIndex++;
        return {
            url: buildUrl(num),
            width: aspect.w,
            height: aspect.h,
        };
    }

    /**
     * Preload a batch of images in the background.
     * Uses <link rel="prefetch"> for low-priority network fetching.
     * @param {number} count - Number of images to preload
     */
    function preload(count = 20) {
        for (let i = 0; i < count; i++) {
            const idx = i % imageIndices.length;
            const num = imageIndices[idx];
            const url = buildUrl(num);

            if (preloadedSet.has(url)) continue;
            preloadedSet.add(url);

            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.as = 'image';
            link.href = url;
            document.head.appendChild(link);
        }
    }

    return { getNext, preload };
})();


/* --------------------------------------------------------------------------
   IMAGE POOL
   Pre-allocates a fixed number of DOM nodes and recycles them.
   This avoids expensive DOM creation/destruction during mouse movement.
   -------------------------------------------------------------------------- */
class ImagePool {
    /**
     * @param {HTMLElement} container - Parent element for trail images
     * @param {number}      size     - Number of pooled nodes
     */
    constructor(container, size) {
        this.container = container;
        this.size = size;

        /** @type {PoolNode[]} */
        this.nodes = [];
        this._create();
    }

    /** Build the initial pool of DOM nodes. */
    _create() {
        const fragment = document.createDocumentFragment();

        for (let i = 0; i < this.size; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'trail-image';

            const img = document.createElement('img');
            img.alt = 'Community artwork';
            img.draggable = false;
            img.decoding = 'async';

            wrapper.appendChild(img);
            fragment.appendChild(wrapper);

            this.nodes.push({
                element: wrapper,
                img,
                active: false,
                timer: null,
            });
        }

        this.container.appendChild(fragment);
    }

    /**
     * Acquire an inactive node from the pool.
     * @returns {PoolNode|null}
     */
    acquire() {
        for (const node of this.nodes) {
            if (!node.active) {
                node.active = true;
                return node;
            }
        }
        return null; // Pool exhausted — skip this frame
    }

    /**
     * Release a node back into the pool.
     * @param {PoolNode} node
     */
    release(node) {
        node.active = false;
        node.element.className = 'trail-image'; // Reset classes
        node.element.style.cssText = '';         // Reset inline styles
    }
}


/* --------------------------------------------------------------------------
   IMAGE TRAIL CONTROLLER
   Core logic for spawning trail images on mouse/touch movement.
   -------------------------------------------------------------------------- */
class ImageTrail {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container        - Trail container element
     * @param {number}      [options.poolSize=35]    - Number of pooled DOM nodes
     * @param {number}      [options.throttleMs=70]  - Min ms between spawns
     * @param {number}      [options.distanceMin=50] - Min px cursor must travel to spawn
     * @param {number}      [options.displayMs=1800] - How long images stay visible (ms)
     * @param {number}      [options.fadeOutMs=900]  - Fade-out duration (ms)
     * @param {Object}      [options.sizeRange]      - { min, max } display size in px
     */
    constructor(options) {
        this.container = options.container;
        this.poolSize = options.poolSize || 35;
        this.throttleMs = options.throttleMs || 70;
        this.distanceMin = options.distanceMin || 50;
        this.displayMs = options.displayMs || 1800;
        this.fadeOutMs = options.fadeOutMs || 900;
        this.sizeRange = options.sizeRange || { min: 120, max: 220 };

        /** Internal state */
        this._lastX = 0;
        this._lastY = 0;
        this._lastSpawn = 0;
        this._zCounter = 1;
        this._rafId = null;
        this._pendingSpawn = null;

        /** Create the pool */
        this.pool = new ImagePool(this.container, this.poolSize);

        /** Bind events */
        this._bindEvents();
    }

    /* ------ Event Binding ------ */

    _bindEvents() {
        const hero = document.getElementById('hero');
        if (!hero) return;

        this.isActive = true;

        const handleMove = (e) => {
            if (!this.isActive) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            const rect = hero.getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom) {
                this._scheduleSpawn(clientX, clientY);
            }
        };

        /* Mouse (desktop) & Touch (mobile) */
        document.addEventListener('mousemove', handleMove, { passive: true });
        document.addEventListener('touchmove', handleMove, { passive: true });

        /* Intersection Observer for strict boundary isolation */
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.isActive = true;
                } else {
                    this.isActive = false;
                    this.clearAll();
                    if (this._rafId) {
                        cancelAnimationFrame(this._rafId);
                        this._rafId = null;
                    }
                }
            });
        }, {
            threshold: 0 // Trigger as soon as section is completely hidden or enters
        });

        observer.observe(hero);

        /* Pause when tab is hidden (save resources) */
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
        });
    }

    /** Immediately releases all active trail images back to pool */
    clearAll() {
        for (const node of this.pool.nodes) {
            if (node.active) {
                const el = node.element;
                // Force hide immediately
                el.classList.remove('trail-image--visible');
                el.classList.remove('trail-image--fading');
                this._releaseNode(node);
            }
        }
    }

    /* ------ Spawn Scheduling (RAF batched) ------ */

    /**
     * Schedules a spawn check on the next animation frame.
     * Batches rapid mouse events into a single frame.
     */
    _scheduleSpawn(x, y) {
        this._pendingSpawn = { x, y };

        if (!this._rafId) {
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                if (this._pendingSpawn) {
                    this._trySpawn(this._pendingSpawn.x, this._pendingSpawn.y);
                    this._pendingSpawn = null;
                }
            });
        }
    }

    /**
     * Check throttle & distance thresholds, then spawn if eligible.
     */
    _trySpawn(x, y) {
        const now = performance.now();

        /* Throttle: don't spawn too often */
        if (now - this._lastSpawn < this.throttleMs) return;

        /* Distance: cursor must have moved enough */
        const dx = x - this._lastX;
        const dy = y - this._lastY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < this.distanceMin) return;

        /* Update tracking */
        this._lastX = x;
        this._lastY = y;
        this._lastSpawn = now;

        /* Spawn the image */
        this._spawn(x, y);
    }

    /* ------ Image Spawning ------ */

    _spawn(x, y) {
        const node = this.pool.acquire();
        if (!node) return; // Pool exhausted, skip

        /* Get next image source */
        const source = ImageLoader.getNext();

        /* Randomize display size (keeps aspect ratio from source) */
        const displayW = this.sizeRange.min +
            Math.random() * (this.sizeRange.max - this.sizeRange.min);
        const aspectRatio = source.height / source.width;
        const displayH = displayW * aspectRatio;

        /* Random rotation for organic feel (-12° to +12°) */
        const rotation = (Math.random() - 0.5) * 24;

        /* Slight random offset so images don't stack exactly on cursor */
        const offsetX = (Math.random() - 0.5) * 60;
        const offsetY = (Math.random() - 0.5) * 60;

        /* Position (centered on cursor + offset) */
        const left = x - displayW / 2 + offsetX;
        const top = y - displayH / 2 + offsetY;

        /* Apply styles */
        const el = node.element;
        el.style.width = `${displayW}px`;
        el.style.height = `${displayH}px`;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.setProperty('--rotation', `${rotation}deg`);
        el.style.zIndex = this._zCounter++;

        /* Set image source */
        node.img.onload = () => {
            if (!node.active) return;
            el.classList.add('trail-image--visible');
        };

        /* Handle image load errors gracefully */
        node.img.onerror = () => {
            this._releaseNode(node);
        };

        node.img.src = source.url;

        /* Schedule fade-out */
        if (node.timer) clearTimeout(node.timer);
        node.timer = setTimeout(() => {
            this._fadeOut(node);
        }, this.displayMs);
    }

    /* ------ Fade Out & Cleanup ------ */

    _fadeOut(node) {
        const el = node.element;
        el.classList.remove('trail-image--visible');
        el.classList.add('trail-image--fading');

        /* After fade-out transition completes, release back to pool */
        node.timer = setTimeout(() => {
            this._releaseNode(node);
        }, this.fadeOutMs);
    }

    _releaseNode(node) {
        if (node.timer) {
            clearTimeout(node.timer);
            node.timer = null;
        }
        node.img.src = ''; // Release image memory
        node.img.onload = null;
        node.img.onerror = null;
        this.pool.release(node);
    }
}


/* --------------------------------------------------------------------------
   SUBTLE PARALLAX ON HERO CONTENT
   Adds a gentle floating effect to the headline based on cursor position.
   -------------------------------------------------------------------------- */
function initParallax() {
    const content = document.getElementById('hero-content');
    if (!content) return;

    const INTENSITY = 8; // Max px shift

    document.addEventListener('mousemove', (e) => {
        /* Calculate offset from center (-1 to +1) */
        const cx = (e.clientX / window.innerWidth - 0.5) * 2;
        const cy = (e.clientY / window.innerHeight - 0.5) * 2;

        requestAnimationFrame(() => {
            content.style.transform =
                `translate(${cx * -INTENSITY}px, ${cy * -INTENSITY}px)`;
        });
    }, { passive: true });
}


/* --------------------------------------------------------------------------
   INITIALIZATION
   -------------------------------------------------------------------------- */
function init() {
    const trailContainer = document.getElementById('image-trail');
    if (!trailContainer) {
        console.warn('[ImageTrail] Container #image-trail not found.');
        return;
    }

    /* Preload first batch of images for instant display */
    ImageLoader.preload(25);

    /* Initialize the trail effect */
    new ImageTrail({
        container: trailContainer,
        poolSize: 35,          // Max simultaneous images on screen
        throttleMs: 70,        // Spawn interval throttle
        distanceMin: 50,       // Min cursor movement to trigger spawn (px)
        displayMs: 1800,       // How long each image stays visible
        fadeOutMs: 900,        // Fade-out animation duration
        sizeRange: {
            min: 120,          // Smallest display width (px)
            max: 240,          // Largest display width (px)
        },
    });

    /* Subtle parallax on hero text */
    initParallax();
}

/* Start when DOM is ready */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


/* ==========================================================================
   EXTENDED FUNCTIONALITY — Appended below existing code
   Handles: scroll-reveal animations, smooth scroll, WhatsApp link, 3D carousel
   ========================================================================== */

/* --------------------------------------------------------------------------
   SCROLL-REVEAL (IntersectionObserver)
   Triggers .is-visible on .reveal elements when they enter the viewport.
   -------------------------------------------------------------------------- */
function initScrollReveal() {
    const reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;

    /* Check for IntersectionObserver support (all modern browsers) */
    if (!('IntersectionObserver' in window)) {
        /* Fallback: show everything immediately */
        reveals.forEach((el) => el.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    observer.unobserve(entry.target); // Only animate once
                }
            });
        },
        {
            threshold: 0.12,    // Trigger when 12% visible
            rootMargin: '0px 0px -40px 0px', // Slight offset for natural feel
        }
    );

    reveals.forEach((el) => observer.observe(el));
}


/* --------------------------------------------------------------------------
   SMOOTH SCROLL for "Explore Works" / "More" button
   -------------------------------------------------------------------------- */
function initSmoothScroll() {
    const exploreBtn = document.getElementById('explore-btn');
    if (!exploreBtn) return;

    exploreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById('community-info');
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
            });
        }
    });
}


/* --------------------------------------------------------------------------
   WHATSAPP COMMUNITY LINK
   Sets the correct href on both "Join" buttons.
   Replace the URL below with your actual WhatsApp Community invite link.
   -------------------------------------------------------------------------- */
function initWhatsAppLinks() {
    const WHATSAPP_URL = 'https://chat.whatsapp.com/FEUPWPKfhEM8HCcdIgToPQ?s=cl&p=i&ilr=0';

    const joinBtnHero   = document.getElementById('join-btn');
    const joinBtnBottom = document.getElementById('join-btn-bottom');

    if (joinBtnHero) {
        joinBtnHero.href = WHATSAPP_URL;
        joinBtnHero.target = '_blank';
        joinBtnHero.rel = 'noopener noreferrer';
    }

    if (joinBtnBottom) {
        joinBtnBottom.href = WHATSAPP_URL;
    }
}


/* --------------------------------------------------------------------------
   3D SCROLL-CONTROLLED CAROUSEL
   Arranges cards in a 3D circle and rotates them based on scroll progress.
   -------------------------------------------------------------------------- */
function initCarousel3D() {
    const scrollArea = document.getElementById('carousel-scroll-area');
    const carousel = document.getElementById('carousel-3d');
    const cards = document.querySelectorAll('.carousel-card');
    const hint = document.getElementById('carousel-hint');

    if (!scrollArea || !carousel || !cards.length) return;

    const totalCards = cards.length;
    const angleStep = 360 / totalCards;
    
    // Determine 3D radius based on viewport width
    let radius = 280; // Desktop default
    function updateRadius() {
        const w = window.innerWidth;
        if (w < 420) {
            radius = 150;
        } else if (w < 768) {
            radius = 200;
        } else {
            radius = 280;
        }
    }
    updateRadius();
    window.addEventListener('resize', updateRadius, { passive: true });

    function updateCarousel() {
        const rect = scrollArea.getBoundingClientRect();
        const scrollHeight = rect.height - window.innerHeight;
        
        if (scrollHeight <= 0) return;

        // Calculate progress between 0 and 1
        const progress = Math.max(0, Math.min(1, -rect.top / scrollHeight));

        // Rotate in negative direction for right-to-left rotation when scrolling down
        const rotationAngle = -progress * 360;

        // Apply 3D transforms to each card
        cards.forEach((card, index) => {
            const baseAngle = index * angleStep;
            const currentAngle = baseAngle + rotationAngle;
            
            // Normalize angle to [-180, 180] to calculate distance to front
            let normalizedAngle = currentAngle % 360;
            if (normalizedAngle > 180) normalizedAngle -= 360;
            if (normalizedAngle < -180) normalizedAngle += 360;

            const absAngle = Math.abs(normalizedAngle);

            // Z-coordinate (depth)
            const rad = (currentAngle * Math.PI) / 180;
            const z = Math.cos(rad) * radius;

            // Math.cos(rad) ranges from -1 to 1. Map this progress from 0 (back) to 1 (front)
            const depthProgress = (Math.cos(rad) + 1) / 2;

            // Apply opacity, scale, blur depth effects
            const opacity = 0.15 + 0.85 * Math.pow(depthProgress, 1.8);
            const scale = 0.65 + 0.35 * Math.pow(depthProgress, 1.8);
            const blurVal = (1 - depthProgress) * 4; // Max 4px blur at the back
            
            // Set z-index so front cards are drawn over back cards
            const zIndex = Math.round(depthProgress * 100);

            card.style.transform = `translate(-50%, -50%) rotateY(${currentAngle}deg) translateZ(${radius}px) scale(${scale})`;
            card.style.opacity = opacity;
            card.style.zIndex = zIndex;
            card.style.filter = blurVal > 0.1 ? `blur(${blurVal}px)` : 'none';

            // Mark the front card
            if (absAngle < 22.5) {
                card.classList.add('is-front');
            } else {
                card.classList.remove('is-front');
            }
        });

        // Hide scroll hint once user starts scrolling down the showcase
        if (progress > 0.05) {
            hint.classList.add('is-hidden');
        } else {
            hint.classList.remove('is-hidden');
        }
    }

    // Run initial frame to lay out cards
    updateCarousel();

    // Listen to scroll to update position
    window.addEventListener('scroll', updateCarousel, { passive: true });
}


/* --------------------------------------------------------------------------
   BOOT NEW FEATURES
   Runs after the original init() has completed.
   -------------------------------------------------------------------------- */
function initExtended() {
    initScrollReveal();
    initSmoothScroll();
    initWhatsAppLinks();
    initCarousel3D();
}

/* Attach — runs after DOM is ready (same pattern as original) */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtended);
} else {
    initExtended();
}

