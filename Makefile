.PHONY: check format

check:
	npx tsc --noEmit

format:
	npx prettier --write '*.ts'
