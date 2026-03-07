(function (exports) {
  "use strict";

  var MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  function fmtDollar(n) {
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function fmtShort(n) {
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
    return "$" + n.toFixed(0);
  }

  function fmtDate(d) {
    var p = d.split("-");
    return MONTHS[parseInt(p[1], 10) - 1] + " '" + p[0].slice(2);
  }

  function fmtDateLong(d) {
    var p = d.split("-");
    return (
      MONTHS[parseInt(p[1], 10) - 1] + " " + parseInt(p[2], 10) + ", " + p[0]
    );
  }

  function fmtShares(n) {
    if (n === Math.floor(n)) return n.toLocaleString("en-US");
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  exports.MONTHS = MONTHS;
  exports.fmtDollar = fmtDollar;
  exports.fmtShort = fmtShort;
  exports.fmtDate = fmtDate;
  exports.fmtDateLong = fmtDateLong;
  exports.fmtShares = fmtShares;
})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
