.PHONY: fetch serve stop hash-password test test-python test-js

DATA_DIR ?= ./demo-data

fetch:
	./utils/tickers/fetch_prices.py -d $(DATA_DIR)

serve:
	DATA_DIR=$(DATA_DIR) node app/serve.js &

stop:
	pkill -f "serve.js" || true

test-python:
	python3 -m unittest discover -s tests/ -p "test_*.py" -v

test-js:
	node --test tests/

test: test-python test-js

hash-password:
	@node utils/hash_password.js $(PASSWORD)
