async function fetchInventory() {
  const res = await fetch('/api/inventory');
  if (!res.ok) {
    throw new Error('Failed to fetch inventory');
  }
  return res.json();
}

function formatCurrency(value) {
  if (value === null || typeof value !== 'number' || Number.isNaN(value)) {
    return 'N/A';
  }
  return `$${value.toFixed(2)}`;
}

function renderInventory(data) {
  const grid = document.getElementById('productsGrid');
  const empty = document.getElementById('emptyState');

  grid.innerHTML = '';

  const items = data.items || [];

  if (!items.length) {
    empty.classList.remove('hidden');
    return;
  } else {
    empty.classList.add('hidden');
  }

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'product-card';

    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'product-image-wrapper';

    const qtyBadge = document.createElement('div');
    qtyBadge.className = 'quantity-badge';
    qtyBadge.textContent = `Qty: ${item.quantity ?? 0}`;
    imgWrapper.appendChild(qtyBadge);

    const img = document.createElement('img');
    img.className = 'product-image';
    img.src =
      item.imageUrl ||
      'https://via.placeholder.com/400x300?text=No+Image';
    img.alt = item.name || 'Sealed product';
    imgWrapper.appendChild(img);

    const body = document.createElement('div');
    body.className = 'product-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'product-name';
    nameEl.textContent = item.name || 'Unknown product';
    body.appendChild(nameEl);

    const setEl = document.createElement('div');
    setEl.className = 'product-set';
    setEl.textContent = item.setName || '—';
    body.appendChild(setEl);

    const priceRow = document.createElement('div');
    priceRow.className = 'price-row';

    const yourPrice = document.createElement('div');
    yourPrice.innerHTML = `
      <div class="price-label">Your price (90% market)</div>
      <div class="price-value price-your">${formatCurrency(
        item.yourPrice
      )}</div>
    `;

    const marketPrice = document.createElement('div');
    marketPrice.innerHTML = `
      <div class="price-label">TCGplayer market</div>
      <div class="price-market">${formatCurrency(item.marketPrice)}</div>
    `;

    priceRow.appendChild(yourPrice);
    priceRow.appendChild(marketPrice);
    body.appendChild(priceRow);

    const footer = document.createElement('div');
    footer.className = 'product-footer';

    const tag = document.createElement('div');
    tag.className = 'tag-pill';
    tag.textContent = 'Sealed';
    footer.appendChild(tag);

    if (item.tcgPlayerUrl) {
      const link = document.createElement('a');
      link.className = 'link';
      link.href = item.tcgPlayerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View on TCGplayer';
      footer.appendChild(link);
    }

    body.appendChild(footer);

    if (item.error) {
      const errorEl = document.createElement('div');
      errorEl.className = 'price-label';
      errorEl.style.color = '#f87171';
      errorEl.style.marginTop = '0.35rem';
      errorEl.textContent = item.error;
      body.appendChild(errorEl);
    }

    card.appendChild(imgWrapper);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function applySearchFilter() {
  const query = document
    .getElementById('searchInput')
    .value.trim()
    .toLowerCase();

  const cards = document.querySelectorAll('.product-card');

  cards.forEach((card) => {
    const name = card.querySelector('.product-name').textContent.toLowerCase();
    const set = card.querySelector('.product-set').textContent.toLowerCase();

    if (!query || name.includes(query) || set.includes(query)) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  });
}

async function init() {
  const lastUpdatedEl = document.getElementById('lastUpdated');

  try {
    const data = await fetchInventory();
    renderInventory(data);

    const now = new Date();
    lastUpdatedEl.textContent = `Updated: ${now.toLocaleString()}`;
  } catch (err) {
    console.error(err);
    lastUpdatedEl.textContent =
      'Error fetching inventory – check server logs.';
  }

  document
    .getElementById('searchInput')
    .addEventListener('input', applySearchFilter);
}

document.addEventListener('DOMContentLoaded', init);
