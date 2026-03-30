.PHONY: build serve

build:
	python3 scripts/build_catalog.py

serve:
	python3 -m http.server 8000
