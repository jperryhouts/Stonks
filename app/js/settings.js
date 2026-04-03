(function (exports) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Sub-tab configuration
  // ---------------------------------------------------------------------------

  var SUBTABS = [
    { key: "config",     label: "Config",     dataUrl: "data/config.json",     saveUrl: "/api/config",     mode: "raw" },
    { key: "assets",     label: "Assets",     dataUrl: "data/assets.json",     saveUrl: "/api/assets",     mode: "raw" },
    { key: "retirement", label: "Retirement", dataUrl: "data/retirement.json", saveUrl: "/api/retirement", mode: "parsed" },
  ];

  // ---------------------------------------------------------------------------
  // Client-side validators
  // ---------------------------------------------------------------------------

  /**
   * Validate a parsed config.json object.
   * @param {*} obj
   * @returns {string[]} array of issue strings (empty = valid)
   */
  function validateConfigJson(obj) {
    var issues = [];
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return ["Expected a non-null object"];
    }

    // chartColors is the canonical name; colors is accepted for backwards compatibility
    var colorKeys = ["chartColors", "colors"];
    for (var cki = 0; cki < colorKeys.length; cki++) {
      var colorKey = colorKeys[cki];
      if (obj[colorKey] !== undefined) {
        if (!Array.isArray(obj[colorKey])) {
          issues.push(colorKey + ": must be an array");
        } else {
          for (var ci = 0; ci < obj[colorKey].length; ci++) {
            var entry = obj[colorKey][ci];
            if (typeof entry === "string") continue;
            if (!entry || typeof entry.fill !== "string") {
              issues.push(colorKey + "[" + ci + "]: must have fill (string)");
            }
            if (!entry || typeof entry.stroke !== "string") {
              issues.push(colorKey + "[" + ci + "]: must have stroke (string)");
            }
          }
        }
      }
    }

    // symbolOrder (optional array of strings)
    if (obj.symbolOrder !== undefined) {
      if (!Array.isArray(obj.symbolOrder)) {
        issues.push("symbolOrder: must be an array");
      } else {
        for (var si = 0; si < obj.symbolOrder.length; si++) {
          if (typeof obj.symbolOrder[si] !== "string") {
            issues.push("symbolOrder[" + si + "]: must be a string");
          }
        }
      }
    }

    // exposure (optional object)
    if (obj.exposure !== undefined) {
      var exp = obj.exposure;

      // allocations (optional)
      if (exp.allocations !== undefined) {
        if (Array.isArray(exp.allocations)) {
          // Array format (deprecated): [{ symbol, category, fraction }]
          for (var ai = 0; ai < exp.allocations.length; ai++) {
            var aentry = exp.allocations[ai];
            if (!aentry || typeof aentry.symbol !== "string") {
              issues.push("exposure.allocations[" + ai + "]: must have symbol (string)");
            }
          }
        } else if (typeof exp.allocations === "object" && exp.allocations !== null) {
          // Object format: { symbol: { category: fraction, ... }, ... }
          for (var sym in exp.allocations) {
            var catMap = exp.allocations[sym];
            if (typeof catMap !== "object" || catMap === null || Array.isArray(catMap)) {
              issues.push("exposure.allocations[\"" + sym + "\"]: must be an object mapping categories to fractions");
              continue;
            }
            var sum = 0;
            for (var cat in catMap) {
              var frac = parseFloat(catMap[cat]);
              if (!isFinite(frac)) {
                issues.push("exposure.allocations[\"" + sym + "\"][\"" + cat + "\"]: must be a number");
              } else {
                sum += frac;
              }
            }
            if (isFinite(sum) && Math.abs(sum - 1.0) > 0.01) {
              issues.push("exposure.allocations[\"" + sym + "\"]: fractions sum to " + sum.toFixed(4) + " (expected 1.0)");
            }
          }
        } else {
          issues.push("exposure.allocations: must be an object or array");
        }
      }

      // display (optional array)
      if (exp.display !== undefined) {
        if (!Array.isArray(exp.display)) {
          issues.push("exposure.display: must be an array");
        } else {
          for (var di = 0; di < exp.display.length; di++) {
            var dentry = exp.display[di];
            if (!dentry || typeof dentry.name !== "string") {
              issues.push("exposure.display[" + di + "]: must have name (string)");
            }
            if (!dentry || typeof dentry.color !== "string") {
              issues.push("exposure.display[" + di + "]: must have color (string)");
            }
          }
        }
      }

      // tradeable (optional array of strings)
      if (exp.tradeable !== undefined) {
        if (!Array.isArray(exp.tradeable)) {
          issues.push("exposure.tradeable: must be an array");
        } else {
          for (var ti = 0; ti < exp.tradeable.length; ti++) {
            if (typeof exp.tradeable[ti] !== "string") {
              issues.push("exposure.tradeable[" + ti + "]: must be a string");
            }
          }
        }
      }
    }

    return issues;
  }

  /**
   * Validate a parsed assets.json array.
   * @param {*} arr
   * @returns {string[]} array of issue strings (empty = valid)
   */
  function validateAssetsJson(arr) {
    var issues = [];
    if (!Array.isArray(arr)) {
      return ["Expected an array"];
    }
    var KNOWN_TYPES = ["mortgage", "ibond", "margin_loan"];
    for (var i = 0; i < arr.length; i++) {
      var entry = arr[i];
      if (!entry || typeof entry !== "object") {
        issues.push("Entry " + i + ": must be an object");
        continue;
      }
      if (typeof entry.type !== "string") {
        issues.push("Entry " + i + ": missing type (string)");
      }
      if (typeof entry.name !== "string") {
        issues.push("Entry " + i + ": missing name (string)");
      }
      if (typeof entry.type === "string") {
        if (KNOWN_TYPES.indexOf(entry.type) === -1) {
          issues.push("Entry " + i + ": unknown type \"" + entry.type + "\"");
        } else if (entry.type === "mortgage") {
          var mortgageFields = ["purchaseDate", "homeValue", "downPayment", "loanTermYears", "annualRate"];
          for (var mi = 0; mi < mortgageFields.length; mi++) {
            if (entry[mortgageFields[mi]] === undefined) {
              issues.push("Entry " + i + ": mortgage missing \"" + mortgageFields[mi] + "\"");
            }
          }
        } else if (entry.type === "ibond") {
          var ibondFields = ["purchaseDate", "purchaseValue", "fixedRate", "rates"];
          for (var ii = 0; ii < ibondFields.length; ii++) {
            if (entry[ibondFields[ii]] === undefined) {
              issues.push("Entry " + i + ": ibond missing \"" + ibondFields[ii] + "\"");
            }
          }
          if (entry.rates !== undefined && !Array.isArray(entry.rates)) {
            issues.push("Entry " + i + ": ibond rates must be an array");
          }
        } else if (entry.type === "margin_loan") {
          if (entry.balances === undefined) {
            issues.push("Entry " + i + ": margin_loan missing \"balances\"");
          } else if (!Array.isArray(entry.balances)) {
            issues.push("Entry " + i + ": margin_loan balances must be an array");
          }
        }
      }
    }
    return issues;
  }

  /**
   * Validate a parsed retirement.json object.
   * @param {*} obj
   * @returns {string[]} array of issue strings (empty = valid)
   */
  function validateRetirementJson(obj) {
    var issues = [];
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return ["Expected a non-null object"];
    }

    // accounts (optional array)
    if (obj.accounts !== undefined) {
      if (!Array.isArray(obj.accounts)) {
        issues.push("accounts: must be an array");
      } else {
        for (var ai = 0; ai < obj.accounts.length; ai++) {
          var acct = obj.accounts[ai];
          if (!acct || typeof acct.name !== "string") {
            issues.push("accounts[" + ai + "]: must have name (string)");
          }
        }
      }
    }

    // values (optional array)
    if (obj.values !== undefined) {
      if (!Array.isArray(obj.values)) {
        issues.push("values: must be an array");
      } else {
        for (var vi = 0; vi < obj.values.length; vi++) {
          var val = obj.values[vi];
          if (!val || typeof val.date !== "string") {
            issues.push("values[" + vi + "]: must have date (string)");
          }
          if (!val || typeof val.account !== "string") {
            issues.push("values[" + vi + "]: must have account (string)");
          }
          if (!val || val.value === undefined) {
            issues.push("values[" + vi + "]: must have value");
          }
        }
      }
    }

    // contributions (optional array)
    if (obj.contributions !== undefined) {
      if (!Array.isArray(obj.contributions)) {
        issues.push("contributions: must be an array");
      } else {
        for (var ci = 0; ci < obj.contributions.length; ci++) {
          var contrib = obj.contributions[ci];
          if (!contrib || contrib.date === undefined) {
            issues.push("contributions[" + ci + "]: must have date");
          }
          if (!contrib || contrib.account === undefined) {
            issues.push("contributions[" + ci + "]: must have account");
          }
          if (!contrib || contrib.amount === undefined) {
            issues.push("contributions[" + ci + "]: must have amount");
          }
        }
      }
    }

    return issues;
  }

  // Map sub-tab key to validator
  var VALIDATORS = {
    config:     validateConfigJson,
    assets:     validateAssetsJson,
    retirement: validateRetirementJson,
  };

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------

  /**
   * Build the Settings panel inside container.
   *
   * @param {HTMLElement} container      - the #panel-settings element
   * @param {Function}    reloadAllData  - called after a successful save
   */
  function buildSettingsPanel(container, reloadAllData) {
    container.innerHTML = "";

    // --- Sub-tab nav ---
    var subtabNav = document.createElement("div");
    subtabNav.className = "subtab-nav";

    // --- Pane state ---
    var paneStates = {}; // key -> { loaded: bool, el, textarea, issuesBox, issuesList, successSpan }

    // --- Build panes ---
    var panes = [];
    var navBtns = [];

    for (var si = 0; si < SUBTABS.length; si++) {
      (function (subtab) {
        var btn = document.createElement("button");
        btn.className = "subtab" + (subtab.key === "config" ? " active" : "");
        btn.setAttribute("data-settings-tab", subtab.key);
        btn.textContent = subtab.label;
        subtabNav.appendChild(btn);
        navBtns.push(btn);

        // Pane element
        var pane = document.createElement("div");
        pane.className = "settings-pane" + (subtab.key === "config" ? "" : " hidden");
        pane.setAttribute("data-settings-pane", subtab.key);

        // Textarea
        var textarea = document.createElement("textarea");
        textarea.className = "settings-editor";
        textarea.spellcheck = false;
        pane.appendChild(textarea);

        // Actions row
        var actionsDiv = document.createElement("div");
        actionsDiv.className = "settings-actions";

        var validateBtn = document.createElement("button");
        validateBtn.className = "btn";
        validateBtn.textContent = "Validate";

        var saveBtn = document.createElement("button");
        saveBtn.className = "btn";
        saveBtn.textContent = "Save";

        var successSpan = document.createElement("span");
        successSpan.className = "settings-success";
        successSpan.style.display = "none";

        actionsDiv.appendChild(validateBtn);
        actionsDiv.appendChild(saveBtn);
        actionsDiv.appendChild(successSpan);
        pane.appendChild(actionsDiv);

        // Issues box
        var issuesBox = document.createElement("div");
        issuesBox.className = "settings-issues hidden";
        var issuesList = document.createElement("ul");
        issuesBox.appendChild(issuesList);
        pane.appendChild(issuesBox);

        container.appendChild(pane);
        panes.push(pane);

        // Track state per pane
        var state = {
          loaded: false,
          etag: null,
          pane: pane,
          textarea: textarea,
          issuesBox: issuesBox,
          issuesList: issuesList,
          successSpan: successSpan,
        };
        paneStates[subtab.key] = state;

        // --- Helpers ---

        function showIssues(items) {
          issuesList.innerHTML = "";
          for (var ii = 0; ii < items.length; ii++) {
            var li = document.createElement("li");
            li.textContent = items[ii];
            issuesList.appendChild(li);
          }
          issuesBox.classList.remove("hidden");
          successSpan.style.display = "none";
        }

        function clearIssues() {
          issuesList.innerHTML = "";
          issuesBox.classList.add("hidden");
        }

        function parseAndValidate() {
          var rawText = textarea.value;
          var parsed;
          try {
            parsed = JSON.parse(rawText);
          } catch (e) {
            return { ok: false, issues: ["Invalid JSON: " + e.message] };
          }
          var validator = VALIDATORS[subtab.key];
          var issues = validator(parsed);
          if (issues.length > 0) {
            return { ok: false, issues: issues };
          }
          return { ok: true, parsed: parsed, rawText: rawText };
        }

        function loadPane() {
          fetch(subtab.dataUrl)
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              state.etag = r.headers.get("etag");
              return r.text();
            })
            .then(function (text) {
              textarea.value = text;
              state.loaded = true;
            })
            .catch(function (err) {
              textarea.value = "";
              showIssues(["Failed to load " + subtab.dataUrl + ": " + err.message]);
            });
        }

        // --- Validate button ---
        validateBtn.addEventListener("click", function () {
          var result = parseAndValidate();
          if (!result.ok) {
            showIssues(result.issues);
          } else {
            clearIssues();
            successSpan.textContent = "JSON is valid";
            successSpan.style.display = "";
          }
        });

        // --- Save button ---
        saveBtn.addEventListener("click", function () {
          var result = parseAndValidate();
          if (!result.ok) {
            showIssues(result.issues);
            return;
          }

          var body;
          if (subtab.mode === "raw") {
            body = JSON.stringify({ content: result.rawText });
          } else {
            // "parsed" mode: POST the parsed object directly
            body = JSON.stringify(result.parsed);
          }

          var saveHeaders = { "Content-Type": "application/json" };
          if (state.etag) saveHeaders["If-Match"] = state.etag;

          fetch(subtab.saveUrl, {
            method: "POST",
            headers: saveHeaders,
            body: body,
          })
            .then(function (r) {
              return r.json().then(function (data) {
                return { status: r.status, data: data };
              });
            })
            .then(function (resp) {
              if (resp.status === 412) {
                showIssues(["Save failed: file was modified externally. Reload the page to get the latest version, then re-apply your changes."]);
              } else if (resp.data.error) {
                showIssues([resp.data.error]);
              } else {
                clearIssues();
                successSpan.textContent = "Saved \u2014 data reloaded";
                successSpan.style.display = "";
                if (typeof reloadAllData === "function") reloadAllData();
              }
            })
            .catch(function (err) {
              showIssues(["Save failed: " + err.message]);
            });
        });

        // --- Sub-tab click handler ---
        btn.addEventListener("click", function () {
          // Update nav buttons
          for (var bi = 0; bi < navBtns.length; bi++) {
            navBtns[bi].classList.remove("active");
          }
          btn.classList.add("active");

          // Show/hide panes
          for (var pi = 0; pi < panes.length; pi++) {
            panes[pi].classList.add("hidden");
          }
          pane.classList.remove("hidden");

          // Lazy-load on first activation
          if (!state.loaded) {
            loadPane();
          }
        });

        // Pre-load the first pane (config)
        if (subtab.key === "config") {
          loadPane();
        }

      })(SUBTABS[si]);
    }

    container.insertBefore(subtabNav, container.firstChild);
  }

  exports.buildSettingsPanel = buildSettingsPanel;
  // Export validators for testability if needed
  exports._validateConfigJson = validateConfigJson;
  exports._validateAssetsJson = validateAssetsJson;
  exports._validateRetirementJson = validateRetirementJson;

})(typeof module !== "undefined" ? module.exports : (window.Portfolio = window.Portfolio || {}));
