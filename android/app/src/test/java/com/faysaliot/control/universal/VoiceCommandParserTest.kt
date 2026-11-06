package com.faysaliot.control.universal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceCommandParserTest {
    @Test
    fun parsesEnglishOnAndOffCommands() {
        assertEquals("on", parseVoiceCommand("Please turn on the relay"))
        assertEquals("off", parseVoiceCommand("switch off"))
    }

    @Test
    fun parsesBengaliOnAndOffCommands() {
        assertEquals("on", parseVoiceCommand("লাইট চালু করো"))
        assertEquals("off", parseVoiceCommand("লাইট বন্ধ করুন"))
    }

    @Test
    fun rejectsUnknownAndAmbiguousCommands() {
        assertNull(parseVoiceCommand("What is the weather?"))
        assertNull(parseVoiceCommand("turn on and turn off"))
        assertNull(parseVoiceCommand("do not turn on"))
        assertNull(parseVoiceCommand("চালু করো না"))
    }
}
