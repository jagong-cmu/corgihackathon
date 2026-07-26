"""Upload extraction.

The interesting cases are all failures. A successful text extraction is boring;
what matters is that every way an upload can be unreadable produces a named
error instead of an empty string, because an empty string ingests perfectly and
leaves the learner with a document the tutor silently knows nothing about.
"""

from __future__ import annotations

import io

import pytest

from tutor_agent.retrieval.extract import (
    ExtractionDependencyError,
    UnsupportedDocumentError,
    detect_kind,
    extract_text,
)


class TestDetectKind:
    def test_extension_wins_for_known_types(self):
        assert detect_kind("notes.md") == "text"
        assert detect_kind("syllabus.pdf") == "pdf"
        assert detect_kind("lecture.pptx") == "pptx"

    def test_content_type_is_checked_before_the_extension(self):
        # Browsers routinely send .docx as a generic type; the reverse also
        # happens, and an authoritative content type should win.
        assert detect_kind("problem-set", "application/pdf") == "pdf"

    def test_charset_parameter_does_not_break_matching(self):
        assert detect_kind("notes", "text/plain; charset=utf-8") == "text"

    def test_legacy_office_formats_say_what_to_do(self):
        with pytest.raises(UnsupportedDocumentError, match="Re-save it as .docx"):
            detect_kind("essay.doc")

    def test_unknown_format_lists_what_is_supported(self):
        with pytest.raises(UnsupportedDocumentError, match=r"\.pdf"):
            detect_kind("lecture.mp4", "video/mp4")

    def test_no_extension_and_no_content_type_is_rejected(self):
        # Not treated as text: guessing here is how a zip archive gets indexed
        # as one enormous chunk of binary noise.
        with pytest.raises(UnsupportedDocumentError):
            detect_kind("attachment")


class TestPlainText:
    def test_utf8_round_trips(self):
        result = extract_text("∫x dx = x²/2".encode(), filename="notes.md")
        assert result.kind == "text"
        assert "∫x dx" in result.text

    def test_a_bad_byte_costs_one_character_not_the_upload(self):
        result = extract_text(b"midterm is \xff friday", filename="notes.txt")
        assert "midterm is" in result.text
        assert "friday" in result.text


class TestPdf:
    def test_a_pdf_with_no_text_layer_is_rejected_as_a_scan(self):
        pypdf = pytest.importorskip("pypdf")
        writer = pypdf.PdfWriter()
        writer.add_blank_page(width=200, height=200)
        buffer = io.BytesIO()
        writer.write(buffer)

        # The failure mode this guards: a photographed problem set uploads
        # "successfully", indexes zero chunks, and the tutor has nothing to say
        # about it with no indication anything went wrong.
        with pytest.raises(UnsupportedDocumentError, match="scan"):
            extract_text(buffer.getvalue(), filename="scanned.pdf")

    def test_missing_parser_names_the_extra(self, monkeypatch):
        import builtins

        real_import = builtins.__import__

        def no_pypdf(name, *args, **kwargs):
            if name == "pypdf":
                raise ImportError("no module named pypdf")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", no_pypdf)
        with pytest.raises(ExtractionDependencyError, match="--extra documents"):
            extract_text(b"%PDF-1.4", filename="paper.pdf")


class TestDocx:
    def test_table_rows_are_extracted(self):
        docx = pytest.importorskip("docx")

        document = docx.Document()
        document.add_paragraph("Grading")
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "Midterm"
        table.rows[0].cells[1].text = "40%"
        buffer = io.BytesIO()
        document.save(buffer)

        result = extract_text(buffer.getvalue(), filename="syllabus.docx")
        assert result.kind == "docx"
        assert "Grading" in result.text
        # python-docx omits tables from `paragraphs`, so a naive extractor drops
        # exactly the part of a syllabus a learner asks about.
        assert "Midterm | 40%" in result.text


class TestPptx:
    def test_slide_numbers_survive_extraction(self):
        pptx = pytest.importorskip("pptx")

        presentation = pptx.Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[5])
        slide.shapes.title.text = "Conservation of momentum"
        buffer = io.BytesIO()
        presentation.save(buffer)

        result = extract_text(buffer.getvalue(), filename="lecture.pptx")
        assert result.kind == "pptx"
        assert "Conservation of momentum" in result.text
        # "What was on slide 6" is only answerable if the number is in the text.
        assert "Slide 1" in result.text
        assert result.pages == 1
