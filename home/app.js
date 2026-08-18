/**
 * Bitcoin Toolkit landing page.
 *
 * Three small jobs: draw the node-graph backdrop, reveal sections as they
 * scroll into view, and show whether each local dashboard is actually running.
 */
(() => {
    'use strict';

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── Node-graph backdrop ─────────────────────────────────────────────────
    /**
     * A slow drift of points joined by lines whenever they come close — a
     * stand-in for a peer-to-peer network. Node count scales with the viewport
     * so a phone is not asked to draw a desktop's worth of geometry.
     */
    function startMesh() {
        const canvas = document.getElementById('mesh');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const LINK_DISTANCE = 132;
        let width = 0;
        let height = 0;
        let nodes = [];

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const target = Math.min(96, Math.round((width * height) / 17000));
            nodes = Array.from({ length: target }, () => ({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.22,
                vy: (Math.random() - 0.5) * 0.22,
                r: 0.9 + Math.random() * 1.5,
                // Roughly a third of nodes take the warm tone, the rest cool.
                warm: Math.random() < 0.34,
            }));
        };

        const draw = () => {
            ctx.clearRect(0, 0, width, height);

            for (const node of nodes) {
                node.x += node.vx;
                node.y += node.vy;
                // Wrap rather than bounce: no visible walls.
                if (node.x < -20) node.x = width + 20;
                if (node.x > width + 20) node.x = -20;
                if (node.y < -20) node.y = height + 20;
                if (node.y > height + 20) node.y = -20;
            }

            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i];
                    const b = nodes[j];
                    const dx = a.x - b.x;
                    const dy = a.y - b.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist > LINK_DISTANCE) continue;

                    // Fade the link out as the pair drifts apart.
                    const alpha = (1 - dist / LINK_DISTANCE) * 0.2;
                    ctx.strokeStyle = a.warm || b.warm
                        ? `rgba(247, 147, 26, ${alpha})`
                        : `rgba(59, 169, 245, ${alpha})`;
                    ctx.lineWidth = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }

            for (const node of nodes) {
                ctx.fillStyle = node.warm ? 'rgba(247, 147, 26, 0.55)' : 'rgba(59, 169, 245, 0.5)';
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
                ctx.fill();
            }

            requestAnimationFrame(draw);
        };

        resize();
        window.addEventListener('resize', resize);

        if (reducedMotion) {
            // Draw the graph once and leave it still.
            nodes.forEach((n) => { n.vx = 0; n.vy = 0; });
        }
        requestAnimationFrame(draw);
    }

    // ── Scroll reveals ──────────────────────────────────────────────────────
    function startReveals() {
        const items = document.querySelectorAll('.reveal');

        if (!('IntersectionObserver' in window)) {
            items.forEach((el) => el.classList.add('shown'));
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('shown');
                observer.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

        items.forEach((el) => observer.observe(el));
    }

    // ── Sticky-header shadow ────────────────────────────────────────────────
    function startStickyHeader() {
        const bar = document.querySelector('.topbar');
        const onScroll = () => bar.classList.toggle('stuck', window.scrollY > 12);
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
    }

    // ── Pointer-tracking card glow ──────────────────────────────────────────
    function startCardGlow() {
        document.querySelectorAll('.card').forEach((card) => {
            card.addEventListener('pointermove', (event) => {
                const box = card.getBoundingClientRect();
                card.style.setProperty('--mx', `${((event.clientX - box.left) / box.width) * 100}%`);
                card.style.setProperty('--my', `${((event.clientY - box.top) / box.height) * 100}%`);
            });
        });
    }

    // ── Dashboard liveness ──────────────────────────────────────────────────
    /**
     * Each dashboard runs on its own port, so a normal fetch would be blocked
     * by CORS before we could read the reply. `no-cors` gives back an opaque
     * response we cannot inspect — but it still *resolves* when the server
     * answered and rejects when nothing is listening, which is all we need.
     */
    async function probe(statusEl) {
        const url = statusEl.dataset.probe;
        const card = statusEl.closest('.card');
        const label = statusEl.querySelector('.status-text');

        try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            statusEl.classList.remove('down');
            statusEl.classList.add('up');
            card.classList.remove('is-down');
            label.textContent = 'running';
        } catch (err) {
            statusEl.classList.remove('up');
            statusEl.classList.add('down');
            card.classList.add('is-down');
            label.textContent = 'not running';
        }
    }

    function startProbes() {
        const badges = [...document.querySelectorAll('.status[data-probe]')];
        const check = () => badges.forEach(probe);
        check();
        // Re-check periodically so starting a server updates the page without a reload.
        setInterval(check, 6000);
        window.addEventListener('focus', check);
    }


    // ── Live decoder ────────────────────────────────────────────────────────
    /**
     * Real mainnet transactions, lifted straight out of the blk*.dat fixtures
     * the CLI is graded against — so what the page decodes is the same data the
     * projects were built to handle.
     */
    const SAMPLES = [
        {
            label: 'Simple payment',
            note: 'One SegWit input, a payment and change. The most common shape on the chain.',
            hex: '020000000001012a1ceb68c36c5bf1718bfe62ab9c180946c0e809ada96be4ec558f8c37029fe10100000000fdffffff02ba7ce400000000001600149445dcfad748ee133bb85a21f743834613c75c16c070bc030000000016001411fb61a457d799fb035eb7cad3449a3d00db94be0247304402203622098585cb1242d5b33ccbee4c4f4c9a400f463066777f45400943a4f784c5022052f607e55b8fc9eca346b1d3c3da0bb757d7ef948ed408a4d6cd336138fdb762012102a804867d6a12bf8723b4e561bbcef8ca0c69050e67993b6f76141c03d1f6bb3484ee0c00',
        },
        {
            label: 'Legacy spend',
            note: 'A pre-SegWit input: the signature sits in the transaction body and pays full weight.',
            hex: '0200000001125d3a320748f2cb0fcc9c3fe50ec24bd1473b88b447b699bd5ad09a90cbbac1010000006a47304402204b3219dbbccccf802631df09465100f6b928291b275bada14a47ba9b62170a17022042de267f0afea9cc91a228489857a67c003cbaf4c1d673e5416e68eaf721a07901210342bb29092419a8b4eb631a9d8a4efd701049e7f2baa4365619c299366a5a884ffdffffff02f049020000000000160014eaaa6c216d009ecbe16fd3a42098c5949d5c1ce4640e0600000000001976a91402a0ce5ece49cb9e5b2bc590e9279f16681e0cb488ac84ee0c00',
        },
        {
            label: 'Taproot',
            note: 'A key-path Taproot spend — a single 64-byte signature, the cheapest input there is.',
            hex: '0200000000010136fd89675a9d564bfdb5c9d9f4464fc69ceadc7fb3195ae4e91b171f0811637b0000000000ffffffff02684200000000000022512061a197f90bc4b1324c7570d27c8f356439c3b08fd5fa7ef59a4b4206b5e296b018140100000000002251202eae1e77fdd5629460a8a2ca3568d2e483d014aa1f225e6c49879b9a4c9ccc6c0140fb81648ca0462bf4c2322488d00a794118740ce9f9bb206e2634f65858e5caf17027ca5e415fbd835c353e843aa263efa870324697b386c6da486c7b81a27d1400000000',
        },
        {
            label: 'Data + payments',
            note: 'Carries an OP_RETURN payload alongside real payments — data stamped onto the chain.',
            hex: '0100000001a7c7f6dc39b1691a3161079233bc637ffebd09ab05041afd33c81d66e9be83d6030000006b483045022100f6e86f4150136943071b933ccbe46a0d576f5bf0b82e2661ee71916302491d0302203863bdfd6d9911cace58805ae40de0d2d9703fa3c1ef36b6b8203dba8f9cbecf0121021b27219c6644eff1e324658aa614a525051f42d60e7f83036ca31d01c362cbb2fdffffff040000000000000000536a4c5058325b451f2c02bbe5fd465394aa48cccb61e8dba0d37363c7aabe7fc403991e5fae36fc2fddd71c7a54c957b682d7aacdc0b05053d090075e4f36e94d95d4898fb03e000cee84001c000cd1db00035a0c63040000000000225120d376a3d4afff886f9634207e1505a550612a11675412152c20c163dbc79a42330c63040000000000225120d376a3d4afff886f9634207e1505a550612a11675412152c20c163dbc79a4233857c5007000000001976a914e8cdb871958da45f245270076b72dc31f92804a488ac00000000',
        },
    ];

    const fmt = (n) => Number(n).toLocaleString('en-US');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const shorten = (t, h = 10, tl = 8) =>
        !t ? '—' : (t.length <= h + tl + 3 ? t : `${t.slice(0, h)}…${t.slice(-tl)}`);

    const TYPE_LABEL = {
        p2pkh: 'Legacy (P2PKH)', p2sh: 'Script hash (P2SH)', p2wpkh: 'SegWit (P2WPKH)',
        p2wsh: 'SegWit script (P2WSH)', p2tr: 'Taproot (P2TR)', op_return: 'Data (OP_RETURN)',
        'p2sh-p2wpkh': 'Wrapped SegWit', unknown: 'Unrecognised',
    };

    function startLab() {
        const input = document.getElementById('lab-input');
        const out = document.getElementById('lab-out');
        const errorBox = document.getElementById('lab-error');
        const hint = document.getElementById('lab-hint');
        if (!input) return;

        document.getElementById('lab-samples').innerHTML = SAMPLES.map((sample, i) =>
            `<button class="chip${i === 0 ? ' on' : ''}" data-i="${i}">${esc(sample.label)}</button>`).join('');

        const load = (i) => {
            input.value = SAMPLES[i].hex;
            hint.textContent = SAMPLES[i].note;
            document.querySelectorAll('.lab-samples .chip').forEach((chip, j) =>
                chip.classList.toggle('on', j === i));
            run();
        };

        document.getElementById('lab-samples').addEventListener('click', (event) => {
            const chip = event.target.closest('.chip');
            if (chip) load(Number(chip.dataset.i));
        });

        async function run() {
            errorBox.classList.add('hidden');
            let tx;
            try {
                tx = await window.BtcDecoder.decode(input.value);
            } catch (err) {
                out.classList.add('hidden');
                errorBox.classList.remove('hidden');
                errorBox.textContent = `Could not decode this — ${err.message}`;
                return;
            }
            render(tx);
        }

        function render(tx) {
            out.classList.remove('hidden');
            const saved = tx.segwit
                ? Math.round(((tx.weightIfLegacy - tx.weight) / tx.weightIfLegacy) * 1000) / 10
                : 0;

            out.innerHTML = `
                <div class="res-grid">
                    <div class="res"><span>Transaction ID</span><code class="wrapme">${esc(tx.txid)}</code></div>
                    ${tx.wtxid ? `<div class="res"><span>Witness ID</span><code class="wrapme">${esc(tx.wtxid)}</code></div>` : ''}
                </div>

                <div class="res-stats">
                    <div><span>Inputs</span><b>${fmt(tx.vin.length)}</b></div>
                    <div><span>Outputs</span><b>${fmt(tx.vout.length)}</b></div>
                    <div><span>Total out</span><b>${fmt(tx.totalOut)}</b><i>sats</i></div>
                    <div><span>Size</span><b>${fmt(tx.vbytes)}</b><i>vB</i></div>
                    <div><span>Weight</span><b>${fmt(tx.weight)}</b><i>WU</i></div>
                    <div><span>Version</span><b>${tx.version}</b></div>
                </div>

                <div class="res-flags">
                    <span class="flag ${tx.segwit ? 'on' : ''}">${tx.segwit ? 'SegWit' : 'Legacy'}</span>
                    <span class="flag ${tx.rbf ? 'warn' : ''}">${tx.rbf ? 'Replaceable (RBF)' : 'Not replaceable'}</span>
                    <span class="flag ${tx.locktimeType !== 'none' ? 'warn' : ''}">
                        ${tx.locktimeType === 'none' ? 'No timelock' : `Timelock: ${esc(tx.locktimeType)} ${fmt(tx.locktime)}`}</span>
                    ${tx.segwit ? `<span class="flag good">Saves ${saved}% of block space</span>` : ''}
                </div>

                <div class="res-io">
                    <div class="res-col">
                        <span class="res-head">Spends ${fmt(tx.vin.length)} coin${tx.vin.length === 1 ? '' : 's'}</span>
                        ${tx.vin.map((v, i) => `
                            <div class="io">
                                <code>${esc(shorten(v.txid, 12, 8))}:${v.vout}</code>
                                <span class="io-meta">${v.witness.length ? `${v.witness.length} witness item${v.witness.length === 1 ? '' : 's'}` : 'no witness'}
                                    &middot; seq 0x${v.sequence.toString(16)}</span>
                            </div>`).join('')}
                    </div>
                    <div class="res-col">
                        <span class="res-head">Creates ${fmt(tx.vout.length)} output${tx.vout.length === 1 ? '' : 's'}</span>
                        ${tx.vout.map((o) => `
                            <div class="io">
                                <code>${esc(o.address ? shorten(o.address, 14, 8) : shorten(o.scriptHex, 14, 6))}</code>
                                <span class="io-meta">
                                    <b class="io-amt">${fmt(o.value)}</b> sats &middot;
                                    <span class="io-type t-${esc(o.type)}">${esc(TYPE_LABEL[o.type] || o.type)}</span>
                                </span>
                                ${o.text ? `<span class="io-data">&ldquo;${esc(o.text)}&rdquo;</span>` : ''}
                            </div>`).join('')}
                    </div>
                </div>

                <p class="res-foot">Decoded in your browser &mdash; nothing was sent anywhere.</p>`;
        }

        document.getElementById('lab-decode').addEventListener('click', run);
        load(0);
    }

    // ── Fee estimator ───────────────────────────────────────────────────────
    /**
     * The same per-type sizes Coin Smith's estimator uses. Inputs carry a
     * signature and dominate the cost; outputs are just an amount and a script.
     */
    const IN_VB = { p2pkh: 148, 'p2sh-p2wpkh': 91, p2wpkh: 68, p2wsh: 105, p2tr: 58 };
    const OUT_VB = { p2pkh: 34, p2sh: 32, p2wpkh: 31, p2wsh: 43, p2tr: 43 };
    const OVERHEAD_VB = 11;
    const MAX_BLOCK_WEIGHT = 4000000;

    function startCalculator() {
        const rate = document.getElementById('calc-rate');
        if (!rate) return;

        // Derived from the size tables so every row always has a count.
        const zeroed = (table) => Object.fromEntries(Object.keys(table).map((k) => [k, 0]));
        const counts = { in: zeroed(IN_VB), out: zeroed(OUT_VB) };
        counts.in.p2wpkh = 1;
        counts.out.p2wpkh = 2;

        const rowsFor = (side, table) => Object.keys(table).map((type) => `
            <div class="calc-row">
                <span class="calc-type t-${type}">${esc(TYPE_LABEL[type] || type)}</span>
                <span class="calc-vb">${side === 'in' ? IN_VB[type] : OUT_VB[type]} vB each</span>
                <span class="stepper">
                    <button data-side="${side}" data-type="${type}" data-step="-1" aria-label="one fewer">&minus;</button>
                    <b id="n-${side}-${type}">${counts[side][type]}</b>
                    <button data-side="${side}" data-type="${type}" data-step="1" aria-label="one more">+</button>
                </span>
            </div>`).join('');

        document.getElementById('calc-inputs').innerHTML = rowsFor('in', IN_VB);
        document.getElementById('calc-outputs').innerHTML = rowsFor('out', OUT_VB);

        function recompute() {
            const inVb = Object.entries(counts.in).reduce((sum, [t, n]) => sum + n * IN_VB[t], 0);
            const outVb = Object.entries(counts.out).reduce((sum, [t, n]) => sum + n * OUT_VB[t], 0);
            const totalIn = Object.values(counts.in).reduce((a, b) => a + b, 0);
            const vbytes = totalIn === 0 ? 0 : OVERHEAD_VB + inVb + outVb;
            const weight = vbytes * 4;
            const feeRate = Number(rate.value);
            const fee = Math.ceil(vbytes * feeRate);

            document.getElementById('calc-rate-label').textContent = feeRate;
            document.getElementById('calc-fee').textContent = fmt(fee);
            document.getElementById('calc-vbytes').textContent = fmt(vbytes);
            document.getElementById('calc-weight').textContent = fmt(weight);
            document.getElementById('calc-share').textContent =
                ((weight / MAX_BLOCK_WEIGHT) * 100).toFixed(4);

            const note = document.getElementById('calc-note');
            if (totalIn === 0) {
                note.textContent = 'Add at least one input — a transaction has to spend something.';
                return;
            }
            const perExtraInput = Math.ceil(IN_VB.p2wpkh * feeRate);
            const perExtraOutput = Math.ceil(OUT_VB.p2wpkh * feeRate);
            note.innerHTML = `At ${feeRate} sat/vB one more SegWit input costs about
                <b>${fmt(perExtraInput)} sats</b>, while one more output costs about
                <b>${fmt(perExtraOutput)} sats</b> — roughly ${(IN_VB.p2wpkh / OUT_VB.p2wpkh).toFixed(1)}× cheaper.
                That is why a wallet holding many small coins is expensive to spend from.`;
        }

        document.querySelector('.calc-controls').addEventListener('click', (event) => {
            const button = event.target.closest('button[data-side]');
            if (!button) return;
            const { side, type, step } = button.dataset;
            counts[side][type] = Math.max(0, Math.min(50, counts[side][type] + Number(step)));
            document.getElementById(`n-${side}-${type}`).textContent = counts[side][type];
            recompute();
        });

        rate.addEventListener('input', recompute);
        recompute();
    }

    startMesh();
    startReveals();
    startStickyHeader();
    startCardGlow();
    startProbes();
    startLab();
    startCalculator();
})();
