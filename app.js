/*
 * Fast Food Finder – application logic
 *
 * This script drives the location lookup, Overpass API requests, category
 * selection and spinning wheel animation. It has been written to be
 * self‑contained and easy to follow. If you’d like to adjust the search
 * radius, category mappings or wheel behaviour, look for the constants
 * defined near the top of this file.
 */

(() => {
  // ----- Configuration -----
  // Approximate driving distance radius in metres (5–10 minute drive).
  const SEARCH_RADIUS = 8000;
  // Maximum number of restaurants to display on the wheel.
  // Allow many places on the wheel. Using a high limit ensures that when
  // selecting "All" you see all nearby options instead of being limited
  // to only a handful. The number of segments can become large, but this
  // fulfils the user’s request.
  const MAX_WHEEL_ITEMS = 100;
  // Colour palette for wheel segments. We recycle colours if there are
  // more segments than colours.
  const COLOR_PALETTE = [
    '#FF6B6B', '#FFB36B', '#FFD86B', '#6BFFB8', '#6BEFFF',
    '#6B83FF', '#B36BFF', '#FF6BCD', '#FF6B9D', '#8AFF6B'
  ];
  // Maps cuisine keywords to Font Awesome icons. Extend this as desired.
  const ICON_MAP = {
    pizza: 'fa-pizza-slice',
    burger: 'fa-hamburger',
    chicken: 'fa-drumstick-bite',
    sandwich: 'fa-hamburger', // treat sandwiches like burgers for category
    thai: 'fa-pepper-hot',
    indian: 'fa-pepper-hot',
    chinese: 'fa-pepper-hot',
    coffee: 'fa-mug-hot',
    noodle: 'fa-bowl-rice',
    sushi: 'fa-fish',
    asian: 'fa-utensils',
    kebab: 'fa-hotdog',
    bakery: 'fa-cookie-bite',
    fish: 'fa-fish',
    default: 'fa-utensils'
  };

  // ----- Helper functions -----

  /**
   * Compute the distance between two sets of coordinates using the
   * Haversine formula. Returns distance in metres.
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in metres
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Attempt to geocode a free‑form address string using the Nominatim
   * geocoding service. Returns a promise resolving to {lat, lon} or
   * rejecting with an error message.
   */
  function geocodeAddress(query) {
    return new Promise((resolve, reject) => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      fetch(url, { headers: { 'Accept-Language': 'en' } })
        .then(response => response.json())
        .then(data => {
          if (data && data.length > 0) {
            const place = data[0];
            resolve({ lat: parseFloat(place.lat), lon: parseFloat(place.lon) });
          } else {
            reject('Location not found. Please try a different address.');
          }
        })
        .catch(() => reject('Could not geocode the address.'));
    });
  }

  /**
   * Query the Overpass API for takeaway restaurants near the given
   * coordinates. Only places with amenity=fast_food or amenity=restaurant
   * and takeaway=yes are considered. Returns a promise resolving to an
   * array of place objects containing name, lat, lon, distance and tags.
   */
  function fetchPlaces(lat, lon) {
    return new Promise((resolve, reject) => {
      // Build Overpass QL query. We search for nodes (points) tagged as
      // fast_food or restaurant within the specified radius. We request the
      // JSON output format. Using around:radius,lat,lon to specify the
      // centre point.
      const query = `[out:json];` +
        `node["amenity"~"fast_food|restaurant"](around:${SEARCH_RADIUS},${lat},${lon});` +
        `out;`;
      const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      fetch(url)
        .then(resp => {
          if (!resp.ok) throw new Error('Network response was not ok');
          return resp.json();
        })
        .then(json => {
          const places = [];
          if (json.elements) {
            json.elements.forEach(elem => {
              const name = (elem.tags && elem.tags.name) ? elem.tags.name.trim() : null;
              const takeaway = elem.tags && elem.tags.takeaway;
              // Skip unnamed places or those that explicitly don’t offer takeaway
              if (!name || takeaway === 'no') return;
              const dist = haversineDistance(lat, lon, elem.lat, elem.lon);
              places.push({
                name,
                lat: elem.lat,
                lon: elem.lon,
                distance: dist,
                tags: elem.tags
              });
            });
          }
          resolve(places);
        })
        .catch(err => reject(err.message || 'Failed to fetch places from Overpass.'));
    });
  }

  /**
   * Derive a simplified cuisine keyword from a place’s tags. If
   * none of the known cuisine keys are found, return 'default'.
   */
  function getCuisineKey(tags) {
    if (!tags) return 'default';
    // Use cuisine tag if available
    if (tags.cuisine) {
      const cuisines = tags.cuisine.split(';');
      for (const c of cuisines) {
        let key = c.trim().toLowerCase();
        // Normalise certain cuisines
        if (key === 'sandwich') key = 'burger';
        if (ICON_MAP[key]) return key;
      }
    }
    // Fallback to keywords in name
    const name = tags.name ? tags.name.toLowerCase() : '';
    for (let key of Object.keys(ICON_MAP)) {
      if (key === 'default') continue;
      // normalise
      const synonyms = {
        sandwich: 'burger',
        kebab: 'burger'
      };
      let searchKey = key;
      if (synonyms[key]) searchKey = synonyms[key];
      if (name.includes(searchKey)) return searchKey;
    }
    return 'default';
  }

  /**
   * Build and display category cards based on the frequency of cuisine keys
   * among the fetched places. The top six categories are shown. Each card
   * can be clicked to filter the wheel items.
   */
  function renderCategories(places) {
    const container = document.getElementById('choices-container');
    container.innerHTML = '';
    // Predefined categories that we always show. Keys must correspond to
    // cuisine keys returned from getCuisineKey(). Labels are what appear in the UI.
    const FIXED_CATEGORIES = [
      { key: 'burger', label: 'Burger' },
      { key: 'pizza', label: 'Pizza' },
      { key: 'chicken', label: 'Fried Chicken' },
      { key: 'chinese', label: 'Chinese' },
      { key: 'thai', label: 'Thai' },
      { key: 'indian', label: 'Indian' }
    ];
    // Count occurrences for each fixed category
    const counts = {};
    places.forEach(p => {
      const key = getCuisineKey(p.tags);
      counts[key] = (counts[key] || 0) + 1;
    });
    // Selected keys array; empty means all
    let selectedKeys = [];
    // Helper to refresh active classes and wheel
    function updateWheel() {
      // update card classes
      document.querySelectorAll('.choice').forEach(card => {
        const k = card.dataset.key;
        if (k === 'all') {
          if (selectedKeys.length === 0) card.classList.add('active');
          else card.classList.remove('active');
        } else {
          if (selectedKeys.includes(k)) card.classList.add('active');
          else card.classList.remove('active');
        }
      });
      // Filter items based on selected keys
      let filtered;
      if (selectedKeys.length === 0) {
        filtered = places;
      } else {
        filtered = places.filter(p => selectedKeys.includes(getCuisineKey(p.tags)));
      }
      initWheelSection(filtered);
    }
    // “All” card
    const allCard = document.createElement('div');
    allCard.className = 'choice active';
    allCard.dataset.key = 'all';
    allCard.innerHTML = `<i class="fa-solid fa-compass"></i><span>All (${places.length})</span>`;
    allCard.addEventListener('click', () => {
      // Clear selections
      selectedKeys = [];
      updateWheel();
    });
    container.appendChild(allCard);
    // Cards for each fixed category
    FIXED_CATEGORIES.forEach(cat => {
      // Skip categories with no items
      const count = counts[cat.key] || 0;
      if (count === 0) return;
      const card = document.createElement('div');
      card.className = 'choice';
      card.dataset.key = cat.key;
      const iconClass = ICON_MAP[cat.key] || ICON_MAP.default;
      card.innerHTML = `<i class="fa-solid ${iconClass}"></i><span>${cat.label} (${count})</span>`;
      card.addEventListener('click', () => {
        // Toggle selection
        const index = selectedKeys.indexOf(cat.key);
        if (index >= 0) selectedKeys.splice(index, 1);
        else selectedKeys.push(cat.key);
        updateWheel();
      });
      container.appendChild(card);
    });
    // Show the choices section and initialise wheel
    document.getElementById('choices-section').classList.remove('hidden');
    updateWheel();
  }

  /**
   * Prepare the wheel section with the supplied places. Sorts by distance
   * and limits to MAX_WHEEL_ITEMS entries. If there are fewer than two
   * places, the spin button is disabled and an appropriate message is shown.
   */
  function initWheelSection(places) {
    const wheelSection = document.getElementById('wheel-section');
    const spinBtn = document.getElementById('spin-btn');
    const winnerDiv = document.getElementById('winner');
    winnerDiv.classList.add('hidden');
    if (!places || places.length === 0) {
      spinBtn.disabled = true;
      spinBtn.textContent = 'No places found';
      return;
    }
    // Sort by distance ascending and take up to MAX_WHEEL_ITEMS
    const sorted = [...places].sort((a, b) => a.distance - b.distance);
    const items = sorted.slice(0, MAX_WHEEL_ITEMS);
    // Store items on the button for later reference
    spinBtn.disabled = false;
    spinBtn.textContent = 'Spin the wheel';
    spinBtn.dataset.items = JSON.stringify(items);
    // Show wheel section
    wheelSection.classList.remove('hidden');
    // Draw initial wheel segments without rotation
    const canvas = document.getElementById('wheel');
    const wheel = new Wheel(canvas, items, COLOR_PALETTE);
    // Store the wheel object on the canvas for reuse during spin
    canvas._wheelObj = wheel;
  }

  /**
   * Class representing a spinning wheel. It draws a segmented wheel on
   * a canvas and animates the rotation when spin() is called.
   */
  class Wheel {
    constructor(canvas, items, colors) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.items = items;
      this.colors = colors;
      this.rotation = 0;
      this.draw();
    }
    draw() {
      const ctx = this.ctx;
      const { width, height } = this.canvas;
      const radius = Math.min(width, height) / 2;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(this.rotation * Math.PI / 180);
      const segCount = this.items.length;
      const arcAngle = (2 * Math.PI) / segCount;
      for (let i = 0; i < segCount; i++) {
        const startAngle = i * arcAngle;
        const endAngle = startAngle + arcAngle;
        // Draw segment
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, startAngle, endAngle);
        ctx.closePath();
        const fillColour = this.colors[i % this.colors.length];
        ctx.fillStyle = fillColour;
        ctx.fill();
        // Draw text. Choose white or dark text based on segment brightness.
        ctx.save();
        // Rotate to the middle of the segment so the x‑axis points along the radius
        ctx.rotate(startAngle + arcAngle / 2);
        // Choose text colour based on segment luminance for contrast
        const rgb = fillColour.replace('#','').match(/.{1,2}/g).map(c => parseInt(c, 16));
        const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
        ctx.fillStyle = luminance < 0.6 ? '#ffffff' : '#333333';
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        // Derive a label and compute spacing so the text spans most of the radius
        const rawLabel = this.items[i].name;
        const truncated = rawLabel.length > 20 ? rawLabel.substring(0, 17) + '…' : rawLabel;
        const label = truncated;
        const maxLength = radius * 0.8; // let the last character stop before edge
        const spacing = label.length > 1 ? maxLength / (label.length - 1) : 0;
        for (let c = 0; c < label.length; c++) {
          const ch = label[c];
          // Move outwards for each character
          ctx.save();
          ctx.translate(spacing * c, 0);
          ctx.fillText(ch, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      }
      ctx.restore();
    }
    /**
     * Animate spinning the wheel and resolve with the selected item. Accepts
     * a callback which is invoked when the animation ends.
     */
    spin(callback) {
      const totalRotation = 360 * 6 + Math.random() * 360; // at least 6 full rotations
      const duration = 6000; // spin duration in ms
      const startRotation = this.rotation;
      let startTime = null;
      const animate = (time) => {
        if (!startTime) startTime = time;
        const elapsed = time - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic for a natural deceleration
        const eased = 1 - Math.pow(1 - progress, 3);
        this.rotation = startRotation + eased * totalRotation;
        this.draw();
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          // Determine winning index. Pointer is at 0 degrees (pointing down),
          // so we take the inverse of the final rotation.
          const finalAngle = this.rotation % 360;
          const segAngle = 360 / this.items.length;
          let angle = (360 - finalAngle) % 360;
          const index = Math.floor(angle / segAngle);
          const winner = this.items[index];
          if (callback) callback(winner);
        }
      };
      requestAnimationFrame(animate);
    }
  }

  /**
   * Handle the full location flow: from receiving coordinates to fetching
   * places and rendering categories/wheel. Accepts lat and lon.
   */
  function handleLocation(lat, lon) {
    const statusElem = document.getElementById('location-status');
    statusElem.textContent = 'Searching for takeaway spots…';
    fetchPlaces(lat, lon)
      .then(places => {
        if (places.length === 0) {
          statusElem.textContent = 'No takeaway places found nearby. Try expanding your search radius.';
          return;
        }
        statusElem.textContent = '';
        renderCategories(places);
      })
      .catch(err => {
          statusElem.textContent = err;
      });
  }

  // ----- Event listeners -----
  document.addEventListener('DOMContentLoaded', () => {
    const useLocationBtn = document.getElementById('use-location-btn');
    const searchBtn = document.getElementById('search-btn');
    const spinBtn = document.getElementById('spin-btn');
    const locationInput = document.getElementById('location-input');

    // Use geolocation API
    useLocationBtn.addEventListener('click', () => {
      const statusElem = document.getElementById('location-status');
      statusElem.textContent = 'Requesting your location…';
      if (!navigator.geolocation) {
        statusElem.textContent = 'Geolocation is not supported by your browser.';
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => {
          const { latitude, longitude } = pos.coords;
          statusElem.textContent = '';
          handleLocation(latitude, longitude);
        },
        err => {
          statusElem.textContent = 'Unable to retrieve your location. You can enter it manually instead.';
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    // Manual search via address
    searchBtn.addEventListener('click', () => {
      const query = locationInput.value.trim();
      if (!query) return;
      const statusElem = document.getElementById('location-status');
      statusElem.textContent = 'Geocoding address…';
      geocodeAddress(query)
        .then(({ lat, lon }) => {
          statusElem.textContent = '';
          handleLocation(lat, lon);
        })
        .catch(err => {
          statusElem.textContent = err;
        });
    });

    // Handle wheel spin
    spinBtn.addEventListener('click', () => {
      if (spinBtn.disabled) return;
      // Retrieve items from dataset (stringified JSON)
      const items = JSON.parse(spinBtn.dataset.items || '[]');
      if (!items || items.length === 0) return;
      const canvas = document.getElementById('wheel');
      const wheel = canvas._wheelObj;
      if (!wheel) return;
      spinBtn.disabled = true;
      spinBtn.textContent = 'Spinning…';
      wheel.spin(winner => {
        spinBtn.disabled = false;
        spinBtn.textContent = 'Spin again';
        // Show winner information
        const winnerDiv = document.getElementById('winner');
        document.getElementById('winner-name').textContent = winner.name;
        // Directions link to Google Maps using directions mode
        const dirLink = document.getElementById('directions-link');
        dirLink.href = `https://www.google.com/maps/dir/?api=1&destination=${winner.lat},${winner.lon}`;
        // Order link will perform a web search for the restaurant name with "order online"
        const orderLink = document.getElementById('order-link');
        orderLink.href = `https://www.google.com/search?q=${encodeURIComponent(winner.name + ' order online')}`;
        winnerDiv.classList.remove('hidden');
      });
    });
  });
})();