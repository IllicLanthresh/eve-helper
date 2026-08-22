#!/bin/sh
# assemble <Name>.body.html + _style.css into <Name>.dc.html
set -e
for b in *.body.html; do
  n=${b%.body.html}
  {
    printf '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n'
    printf '<title>%s</title>\n' "$n"
    printf '<script src="./support.js"></script>\n<style>\n'
    cat _style.css
    sed -n '/^<style-extra>/,/^<\/style-extra>/p' "$b" | sed '1d;$d'
    printf '</style>\n</head>\n<body>\n'
    sed '/^<style-extra>/,/^<\/style-extra>/d' "$b"
    printf '</body>\n</html>\n'
  } > "$n.dc.html"
  echo "built $n.dc.html"
done
